import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';
import { createAutomationJob } from './automation-jobs';

const sha256 = /^[a-f0-9]{64}$/i;
const MAX_CONFIRMATION_TEXT_LENGTH = 100_000;
const PROVIDER_SUCCESS_STATUSES = new Set(['accepted', 'confirmed', 'received', 'submitted', 'success', 'succeeded']);

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export class SubmissionVerificationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED', message: string) {
    super(message);
    this.name = 'SubmissionVerificationError';
  }
}

export interface SubmissionVerificationEvidence {
  applicationId: string;
  /** Exact durable execution attempt when the verifier was created by the submission worker. */
  attemptId?: string;
  provider: 'GREENHOUSE' | 'LEVER';
  confirmationId: string;
  evidenceHash: string;
  parserVersion: string;
  observedAt: Date;
  source: 'CONFIRMATION_PAGE' | 'PROVIDER_RESPONSE' | 'APPLICATION_ID';
}

export function validateSubmissionVerificationRequest(input: { userId: string; applicationId: string; correlationId: string }): void {
  if (!input || typeof input.userId !== 'string' || typeof input.applicationId !== 'string' || typeof input.correlationId !== 'string'
    || !input.userId.trim() || !input.applicationId.trim() || !input.correlationId.trim() || input.correlationId.length > 200) {
    throw new SubmissionVerificationError('INVALID', 'Submission verification request identifiers are incomplete or oversized');
  }
  if (hasControlCharacters(input.userId) || hasControlCharacters(input.applicationId) || hasControlCharacters(input.correlationId)) {
    throw new SubmissionVerificationError('INVALID', 'Submission verification request identifiers contain control characters');
  }
}

export function hasDurableSubmissionAttemptEvidence(attempts: readonly { status: string; startedAt: Date; completedAt: Date | null }[], observedAt: Date): boolean {
  return selectDurableSubmissionAttempt(attempts, observedAt) !== null;
}

export function selectDurableSubmissionAttempt<T extends { id?: string; status: string; startedAt: Date; completedAt: Date | null }>(attempts: readonly T[], observedAt: Date, attemptId?: string): T | null {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) return null;
  const observedTime = observedAt.getTime();
  return attempts
    .filter(attempt => attempt && (!attemptId || attempt.id === attemptId) && (attempt.status === 'UNCONFIRMED' || attempt.status === 'OUTCOME_UNKNOWN')
      && attempt.startedAt instanceof Date && Number.isFinite(attempt.startedAt.getTime())
      && (attempt.completedAt === null || (attempt.completedAt instanceof Date && Number.isFinite(attempt.completedAt.getTime())))
      && attempt.startedAt.getTime() <= observedTime
      && Boolean(attempt.completedAt)
      && attempt.completedAt!.getTime() >= attempt.startedAt.getTime()
      && attempt.completedAt!.getTime() <= observedTime)
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null;
}

export function validateSubmissionVerificationEvidence(evidence: SubmissionVerificationEvidence): void {
  if (!evidence || typeof evidence.applicationId !== 'string' || (evidence.attemptId !== undefined && typeof evidence.attemptId !== 'string') || typeof evidence.confirmationId !== 'string' || typeof evidence.parserVersion !== 'string'
    || typeof evidence.evidenceHash !== 'string' || !(evidence.observedAt instanceof Date)
    || !evidence.applicationId.trim() || evidence.applicationId.length > 200 || !evidence.confirmationId.trim() || evidence.confirmationId.length > 200 || !evidence.parserVersion.trim() || evidence.parserVersion.length > 100
    || !['GREENHOUSE', 'LEVER'].includes(evidence.provider) || !['CONFIRMATION_PAGE', 'PROVIDER_RESPONSE', 'APPLICATION_ID'].includes(evidence.source)
    || !sha256.test(evidence.evidenceHash) || Number.isNaN(evidence.observedAt.getTime())
    || evidence.observedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new SubmissionVerificationError('INVALID', 'Independent submission evidence is incomplete or has an invalid hash');
  }
  if (hasControlCharacters(evidence.applicationId) || hasControlCharacters(evidence.confirmationId) || hasControlCharacters(evidence.parserVersion)) {
    throw new SubmissionVerificationError('INVALID', 'Independent submission evidence identifiers contain control characters');
  }
  if (evidence.attemptId !== undefined && (!evidence.attemptId.trim() || evidence.attemptId.length > 200 || hasControlCharacters(evidence.attemptId))) {
    throw new SubmissionVerificationError('INVALID', 'Independent submission evidence attempt identity is invalid');
  }
}

/** Normalize only bounded confirmation signals; never persist the page text itself. */
export function parseProviderConfirmation(input: {
  applicationId: string;
  attemptId?: string;
  provider: SubmissionVerificationEvidence['provider'];
  pageText: string;
  observedAt: Date;
}): SubmissionVerificationEvidence {
  if (!input || typeof input.pageText !== 'string') {
    throw new SubmissionVerificationError('INVALID', 'Confirmation evidence must contain text');
  }
  if (input.pageText.length > MAX_CONFIRMATION_TEXT_LENGTH) {
    throw new SubmissionVerificationError('INVALID', 'Confirmation evidence is oversized');
  }
  const text = input.pageText.replace(/\s+/g, ' ').trim();
  const marker = /(?:application\s+(?:received|submitted)|thank(?:s| you)\s+for\s+applying|your\s+application\s+has\s+been\s+received)/i.test(text);
  const identifier = text.match(/(?:application|confirmation|candidate)\s*(?:(?:id|number)\s*)?[:#-]\s*([a-z0-9][a-z0-9_-]{3,})/i)?.[1];
  if (!marker || !identifier) throw new SubmissionVerificationError('INVALID', 'Confirmation page lacks an independent confirmation marker and identifier');
  const evidenceHash = createHash('sha256').update(input.pageText, 'utf8').digest('hex');
  const evidence: SubmissionVerificationEvidence = {
    applicationId: input.applicationId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    provider: input.provider,
    confirmationId: identifier,
    evidenceHash,
    parserVersion: 'confirmation-parser/1.0.0',
    observedAt: input.observedAt,
    source: 'CONFIRMATION_PAGE',
  };
  validateSubmissionVerificationEvidence(evidence);
  return evidence;
}

/** Normalize a provider response at the trusted adapter boundary without persisting arbitrary response data. */
export function parseProviderResponse(input: {
  applicationId: string;
  attemptId?: string;
  provider: SubmissionVerificationEvidence['provider'];
  response: { confirmationId?: unknown; applicationId?: unknown; status?: unknown };
  observedAt: Date;
}): SubmissionVerificationEvidence {
  if (!input || !input.response || typeof input.response !== 'object' || Array.isArray(input.response)) {
    throw new SubmissionVerificationError('INVALID', 'Provider response evidence must be an object');
  }
  const response = input.response;
  const confirmationId = [response.confirmationId, response.applicationId].find(value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{3,199}$/i.test(value.trim())) as string | undefined;
  const status = typeof response.status === 'string' ? response.status.trim().toLowerCase() : '';
  if (!confirmationId || !PROVIDER_SUCCESS_STATUSES.has(status)) {
    throw new SubmissionVerificationError('INVALID', 'Provider response lacks an accepted status and confirmation identifier');
  }
  const normalized = JSON.stringify({ provider: input.provider, status, confirmationId: confirmationId.trim() });
  const evidence: SubmissionVerificationEvidence = {
    applicationId: input.applicationId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    provider: input.provider,
    confirmationId: confirmationId.trim(),
    evidenceHash: createHash('sha256').update(normalized, 'utf8').digest('hex'),
    parserVersion: 'provider-response-parser/1.0.0',
    observedAt: input.observedAt,
    source: 'PROVIDER_RESPONSE',
  };
  validateSubmissionVerificationEvidence(evidence);
  return evidence;
}

/** Normalize an application identifier returned by a trusted provider boundary. */
export function parseProviderApplicationId(input: {
  applicationId: string;
  attemptId?: string;
  provider: SubmissionVerificationEvidence['provider'];
  providerApplicationId: string;
  observedAt: Date;
}): SubmissionVerificationEvidence {
  if (!input || typeof input.providerApplicationId !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{3,199}$/i.test(input.providerApplicationId.trim())) {
    throw new SubmissionVerificationError('INVALID', 'Provider application ID evidence is missing or unbounded');
  }
  const confirmationId = input.providerApplicationId.trim();
  const normalized = JSON.stringify({ provider: input.provider, confirmationId });
  const evidence: SubmissionVerificationEvidence = {
    applicationId: input.applicationId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    provider: input.provider,
    confirmationId,
    evidenceHash: createHash('sha256').update(normalized, 'utf8').digest('hex'),
    parserVersion: 'provider-application-id-parser/1.0.0',
    observedAt: input.observedAt,
    source: 'APPLICATION_ID',
  };
  validateSubmissionVerificationEvidence(evidence);
  return evidence;
}

export async function queueProviderResponseVerification(input: {
  userId: string;
  applicationId: string;
  attemptId?: string;
  correlationId: string;
  provider: SubmissionVerificationEvidence['provider'];
  response: { confirmationId?: unknown; applicationId?: unknown; status?: unknown };
  observedAt: Date;
}) {
  const evidence = parseProviderResponse(input);
  const automationJob = await createAutomationJob({
    userId: input.userId,
    applicationId: input.applicationId,
    type: 'VERIFY_SUBMISSION_CONFIRMATION',
    payload: { ...evidence, observedAt: evidence.observedAt.toISOString() } as unknown as Prisma.InputJsonValue,
    payloadVersion: 1,
    maxAttempts: 1,
    correlationId: input.correlationId,
    idempotencyKey: `verify-submission:${input.applicationId}:${evidence.evidenceHash}`,
  });
  return { evidence, automationJob };
}

/** Enqueue normalized provider application-ID evidence without retaining raw provider payloads. */
export async function queueProviderApplicationIdVerification(input: {
  userId: string;
  applicationId: string;
  attemptId?: string;
  correlationId: string;
  provider: SubmissionVerificationEvidence['provider'];
  providerApplicationId: string;
  observedAt: Date;
}) {
  const evidence = parseProviderApplicationId(input);
  const automationJob = await createAutomationJob({
    userId: input.userId,
    applicationId: input.applicationId,
    type: 'VERIFY_SUBMISSION_CONFIRMATION',
    payload: { ...evidence, observedAt: evidence.observedAt.toISOString() } as unknown as Prisma.InputJsonValue,
    payloadVersion: 1,
    maxAttempts: 1,
    correlationId: input.correlationId,
    idempotencyKey: `verify-submission:${input.applicationId}:${evidence.evidenceHash}`,
  });
  return { evidence, automationJob };
}

/** Parse trusted browser output and enqueue only normalized evidence metadata. */
export async function queueProviderConfirmationVerification(input: {
  userId: string;
  applicationId: string;
  attemptId?: string;
  correlationId: string;
  provider: SubmissionVerificationEvidence['provider'];
  pageText: string;
  observedAt: Date;
}) {
  const evidence = parseProviderConfirmation({
    applicationId: input.applicationId,
    attemptId: input.attemptId,
    provider: input.provider,
    pageText: input.pageText,
    observedAt: input.observedAt,
  });
  const queued = await createAutomationJob({
    userId: input.userId,
    applicationId: input.applicationId,
    type: 'VERIFY_SUBMISSION_CONFIRMATION',
    payload: { ...evidence, observedAt: evidence.observedAt.toISOString() } as unknown as Prisma.InputJsonValue,
    payloadVersion: 1,
    maxAttempts: 1,
    correlationId: input.correlationId,
    idempotencyKey: `verify-submission:${input.applicationId}:${evidence.evidenceHash}`,
  });
  return { evidence, automationJob: queued };
}

/** Verify a provider confirmation captured by a trusted browser/verifier boundary. */
export async function verifyProviderConfirmation(input: {
  userId: string;
  applicationId: string;
  attemptId?: string;
  correlationId: string;
  provider: SubmissionVerificationEvidence['provider'];
  pageText: string;
  observedAt: Date;
}) {
  const evidence = parseProviderConfirmation({
    applicationId: input.applicationId,
    attemptId: input.attemptId,
    provider: input.provider,
    pageText: input.pageText,
    observedAt: input.observedAt,
  });
  return verifySubmission({
    userId: input.userId,
    applicationId: input.applicationId,
    correlationId: input.correlationId,
    trustedBoundary: true,
    evidence,
  });
}

/** Verify a provider application ID captured by a trusted adapter/verifier boundary. */
export async function verifyProviderApplicationId(input: {
  userId: string;
  applicationId: string;
  attemptId?: string;
  correlationId: string;
  provider: SubmissionVerificationEvidence['provider'];
  providerApplicationId: string;
  observedAt: Date;
}) {
  const evidence = parseProviderApplicationId(input);
  return verifySubmission({
    userId: input.userId,
    applicationId: input.applicationId,
    correlationId: input.correlationId,
    trustedBoundary: true,
    evidence,
  });
}

export async function verifySubmission(input: {
  userId: string;
  applicationId: string;
  correlationId: string;
  /** Internal verifier/worker assertion; never accepted from an HTTP caller. */
  trustedBoundary?: true;
  evidence: SubmissionVerificationEvidence;
}) {
  if (input.trustedBoundary !== true) {
    throw new SubmissionVerificationError('PRECONDITION_FAILED', 'Submission evidence must come from the trusted verifier boundary');
  }
  validateSubmissionVerificationRequest(input);
  validateSubmissionVerificationEvidence(input.evidence);
  if (input.evidence.applicationId !== input.applicationId) {
    throw new SubmissionVerificationError('CONFLICT', 'Verification evidence belongs to a different application');
  }
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:submission-verification:${input.applicationId}`}, 0))`;
    const application = await tx.application.findFirst({
      where: { id: input.applicationId, userId: input.userId },
      include: {
        job: { select: { source: true } },
        attempts: { where: { status: { in: ['UNCONFIRMED', 'OUTCOME_UNKNOWN'] } }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true, completedAt: true } },
      },
    });
    if (!application) throw new SubmissionVerificationError('NOT_FOUND', 'Application not found');
    if (application.job.source.trim().toUpperCase() !== input.evidence.provider) {
      throw new SubmissionVerificationError('CONFLICT', 'Verification evidence provider does not match the application provider');
    }
    // Replay is checked before the attempt gate because successful verification closes
    // the durable attempt; the immutable evidence itself is the replay proof.
    if (application.status === 'CONFIRMED') {
      const confirmedEvidence = application.confirmationId === input.evidence.confirmationId
        ? await tx.submissionVerificationEvidence.findFirst({ where: { applicationId: application.id, confirmationId: input.evidence.confirmationId } })
        : null;
      if (confirmedEvidence
        && confirmedEvidence.userId === input.userId
        && confirmedEvidence.provider === input.evidence.provider
        && confirmedEvidence.confirmationId === input.evidence.confirmationId
        && confirmedEvidence.evidenceHash === input.evidence.evidenceHash
        && confirmedEvidence.parserVersion === input.evidence.parserVersion
        && confirmedEvidence.source === input.evidence.source
        && confirmedEvidence.observedAt.getTime() === input.evidence.observedAt.getTime()) {
        return { application, replayed: true as const };
      }
      throw new SubmissionVerificationError('CONFLICT', 'Application is already confirmed with different evidence');
    }
    if (!application.appliedAt) {
      throw new SubmissionVerificationError('PRECONDITION_FAILED', 'Submission has no persisted attempt timestamp for independent verification');
    }
    const attempt = selectDurableSubmissionAttempt(application.attempts, input.evidence.observedAt, input.evidence.attemptId);
    if (!attempt) {
      throw new SubmissionVerificationError('PRECONDITION_FAILED', 'Submission has no completed durable execution attempt for independent verification');
    }
    if (input.evidence.observedAt < application.appliedAt) {
      throw new SubmissionVerificationError('CONFLICT', 'Verification evidence predates the recorded submission attempt');
    }
    if (application.status !== 'UNCONFIRMED') {
      throw new SubmissionVerificationError('PRECONDITION_FAILED', 'Only an unconfirmed submission can be independently verified');
    }
    const existingEvidence = await tx.submissionVerificationEvidence.findUnique({
      where: { applicationId_evidenceHash: { applicationId: application.id, evidenceHash: input.evidence.evidenceHash } },
    });
    if (existingEvidence && (existingEvidence.userId !== input.userId
      || existingEvidence.attemptId !== attempt.id
      || existingEvidence.provider !== input.evidence.provider
      || existingEvidence.confirmationId !== input.evidence.confirmationId
      || existingEvidence.parserVersion !== input.evidence.parserVersion
      || existingEvidence.source !== input.evidence.source
      || existingEvidence.observedAt.getTime() !== input.evidence.observedAt.getTime())) {
      throw new SubmissionVerificationError('CONFLICT', 'Evidence hash is already bound to different immutable evidence');
    }
    const evidence = existingEvidence ?? await tx.submissionVerificationEvidence.create({
      data: {
        userId: input.userId,
        applicationId: application.id,
        attemptId: attempt.id,
        provider: input.evidence.provider,
        confirmationId: input.evidence.confirmationId,
        evidenceHash: input.evidence.evidenceHash,
        parserVersion: input.evidence.parserVersion,
        source: input.evidence.source,
        observedAt: input.evidence.observedAt,
      },
    });
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: application.id,
      userId: input.userId,
      toStatus: 'CONFIRMED',
      expectedVersion: application.version,
      actorType: 'VERIFIER',
      actorId: 'independent-verifier',
      reason: 'Independent provider evidence confirmed the submission',
      idempotencyKey: `submission-verification:${application.id}:${input.evidence.evidenceHash}`,
      correlationId: input.correlationId,
      metadata: { provider: input.evidence.provider, parserVersion: input.evidence.parserVersion, source: input.evidence.source, evidenceHash: input.evidence.evidenceHash, observedAt: input.evidence.observedAt.toISOString() },
    });
    const confirmed = await tx.application.update({ where: { id: application.id }, data: { confirmationId: input.evidence.confirmationId } });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'SUBMISSION_INDEPENDENTLY_VERIFIED',
        resource: 'Application',
        resourceId: application.id,
        details: { applicationId: application.id, provider: input.evidence.provider, confirmationId: input.evidence.confirmationId, evidenceHash: input.evidence.evidenceHash, parserVersion: input.evidence.parserVersion, source: input.evidence.source, observedAt: input.evidence.observedAt.toISOString() } as Prisma.InputJsonValue,
      },
    });
    await tx.applicationAttempt.update({ where: { id: attempt.id }, data: { status: 'CONFIRMED' } });
    return { application: confirmed, transition: transitioned, evidence, replayed: false as const };
  });
}
