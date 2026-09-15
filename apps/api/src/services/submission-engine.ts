import { Prisma } from '@prisma/client';
import { prisma, withService, withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';
import { ProviderSubmissionError, ProviderSubmissionService } from './provider-submission';
import { DocumentStorageError, validateStoredDocumentMetadata } from './document-storage';
import { safeErrorMessage } from '../observability/structured-log';

const authorizationLifetimeMs = 10 * 60 * 1000;
const activeVerificationStatuses = ['PENDING', 'EXPIRED'];
const maxReviewedAnswerTextLength = 20_000;
const maxReviewedAnswerOptions = 100;
const maxReviewedAnswerOptionLength = 500;

export function safeSubmissionFailureMessage(error: unknown): string {
  return safeErrorMessage(error, 500);
}

type SubmissionExecutor = Pick<ProviderSubmissionService, 'execute'>;

export class SubmissionEngineError extends Error {
  constructor(
    public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'STALE_VERSION' | 'PRECONDITION_FAILED' | 'EXPIRED' | 'UNKNOWN_OUTCOME',
    message: string,
  ) {
    super(message);
    this.name = 'SubmissionEngineError';
  }
}

export interface AuthorizeSubmissionInput {
  userId: string;
  applicationId: string;
  expectedVersion: number;
  idempotencyKey: string;
  correlationId: string;
  now?: Date;
}

export interface ExecuteAuthorizedSubmissionInput {
  userId: string;
  authorizationId: string;
  correlationId: string;
  workerId: string;
  now?: Date;
}

type ProviderExecutionResult = Awaited<ReturnType<ProviderSubmissionService['execute']>>;

export function validateProviderExecutionResult(result: unknown, applicationId: string): asserts result is ProviderExecutionResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'Provider execution returned malformed outcome data');
  }
  const candidate = result as Partial<ProviderExecutionResult>;
  if ((candidate.provider !== 'GREENHOUSE' && candidate.provider !== 'LEVER')
    || !(candidate.attemptedAt instanceof Date) || !Number.isFinite(candidate.attemptedAt.getTime())
    || candidate.attemptedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'Provider execution returned unverifiable outcome metadata');
  }
  if (candidate.confirmation !== undefined
    && (!candidate.confirmation || candidate.confirmation.applicationId !== applicationId
      || candidate.confirmation.provider !== candidate.provider
      || !(candidate.confirmation.observedAt instanceof Date)
      || !Number.isFinite(candidate.confirmation.observedAt.getTime())
      || candidate.confirmation.observedAt.getTime() < candidate.attemptedAt.getTime())) {
    throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'Provider execution returned inconsistent confirmation evidence');
  }
}

function requireText(value: unknown, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new SubmissionEngineError('INVALID', `${name} is required and must be bounded and free of control characters`);
  }
}

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SubmissionEngineError('INVALID', 'Submission time must be a valid Date');
  return now;
}

function requireVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SubmissionEngineError('STALE_VERSION', 'expectedVersion must be a positive integer');
  }
}

function evidenceFacts(sourceFacts: Prisma.JsonValue, approvedFacts: Array<{ id: string; checksum: string }>): { valid: boolean; sourceFactIds: string[] } {
  if (!Array.isArray(sourceFacts) || sourceFacts.length === 0) return { valid: false, sourceFactIds: [] };
  const approved = new Map(approvedFacts.map(fact => [fact.id, fact.checksum]));
  const sourceFactIds: string[] = [];
  for (const source of sourceFacts) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return { valid: false, sourceFactIds: [] };
    const value = source as Record<string, unknown>;
    if (typeof value.sourceFactId !== 'string' || typeof value.sourceChecksum !== 'string' || approved.get(value.sourceFactId) !== value.sourceChecksum) {
      return { valid: false, sourceFactIds: [] };
    }
    sourceFactIds.push(value.sourceFactId);
  }
  return { valid: true, sourceFactIds };
}

export function isReviewedApplicationAnswer(
  answer: { userId: string; approved: boolean; approvedAt: Date | null; approvedBy: string | null; provenance: Prisma.JsonValue; source: string; value?: Prisma.JsonValue; version?: number } | null,
  ownerId: string,
): boolean {
  if (!answer || answer.userId !== ownerId || answer.approved !== true
    || !(answer.approvedAt instanceof Date) || !Number.isFinite(answer.approvedAt.getTime())
    || answer.approvedBy !== ownerId || !['USER_PROFILE', 'USER_INPUT', 'COVER_LETTER', 'AI_SUGGESTION'].includes(answer.source)
    || (answer.version !== undefined && (!Number.isSafeInteger(answer.version) || answer.version < 1))
    || !answer.provenance || typeof answer.provenance !== 'object' || Array.isArray(answer.provenance)) return false;
  if (answer.value !== undefined && !isReviewedAnswerValue(answer.value)) return false;
  const provenance = answer.provenance as Record<string, unknown>;
  return provenance.source === answer.source
    && answer.userId === ownerId
    && answer.approved === true
    && typeof provenance.source === 'string';
}

function isReviewedAnswerValue(value: Prisma.JsonValue): boolean {
  return (typeof value === 'string' && value.length <= maxReviewedAnswerTextLength)
    || typeof value === 'boolean'
    || (Array.isArray(value) && value.length <= maxReviewedAnswerOptions
      && value.every(item => typeof item === 'string' && item.length <= maxReviewedAnswerOptionLength));
}

type ReviewableApplicationAnswer = {
  userId: string;
  approved: boolean;
  approvedAt: Date | null;
  approvedBy: string | null;
  provenance: Prisma.JsonValue;
  source: string;
  value?: Prisma.JsonValue;
  version?: number;
};

/** Relation ordering is not authoritative; choose the newest reviewed version deterministically. */
export function selectReviewedApplicationAnswer<T extends ReviewableApplicationAnswer>(answers: readonly T[], ownerId: string): T | null {
  return answers
    .filter(answer => isReviewedApplicationAnswer(answer, ownerId))
    .sort((left, right) => (right.version ?? 0) - (left.version ?? 0)
      || right.approvedAt!.getTime() - left.approvedAt!.getTime())[0] ?? null;
}

function authorizedDocumentReference(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  const keys = ['id', 'kind', 'resumeVersionId', 'bucket', 'objectKey', 'versionId', 'fileName', 'mimeType', 'byteSize', 'checksumSha256', 'encryptionKeyRef', 'approvalStatus', 'approvedAt', 'approvedBy', 'scanStatus'] as const;
  if (keys.some(key => key !== 'versionId' && key !== 'resumeVersionId' && typeof reference[key] !== 'string')) return null;
  return Object.fromEntries(keys.map(key => [key, reference[key] == null ? null : String(reference[key])])) as Record<string, string | null>;
}

function authorizedDocumentEvidence(preflightEvidence: Prisma.JsonValue): { resumeDocument: Record<string, string | null> | null; coverLetterDocument: Record<string, string | null> | null } {
  if (!preflightEvidence || typeof preflightEvidence !== 'object' || Array.isArray(preflightEvidence)) return { resumeDocument: null, coverLetterDocument: null };
  const evidence = preflightEvidence as Record<string, unknown>;
  return {
    resumeDocument: authorizedDocumentReference(evidence.resumeDocument),
    coverLetterDocument: authorizedDocumentReference(evidence.coverLetterDocument),
  };
}

function documentReference(document: { id: string; kind: string; resumeVersionId: string | null; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; byteSize: bigint; checksumSha256: string; encryptionKeyRef: string | null; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null; scanStatus: string }): Record<string, string | null> {
  return {
    id: document.id, kind: document.kind, resumeVersionId: document.resumeVersionId, bucket: document.bucket, objectKey: document.objectKey,
    versionId: document.versionId, fileName: document.fileName, mimeType: document.mimeType,
    byteSize: document.byteSize.toString(), checksumSha256: document.checksumSha256,
    encryptionKeyRef: document.encryptionKeyRef, approvalStatus: document.approvalStatus ?? null,
    approvedAt: document.approvedAt?.toISOString() ?? null, approvedBy: document.approvedBy ?? null, scanStatus: document.scanStatus,
  };
}

function activeAuthorizationStatus(status: string): boolean {
  return ['AUTHORIZED', 'EXECUTING', 'OUTCOME_UNKNOWN'].includes(status);
}

export async function authorizeSubmission(input: AuthorizeSubmissionInput) {
  requireText(input.userId, 'userId');
  requireText(input.applicationId, 'applicationId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  requireText(input.correlationId, 'correlationId');
  requireVersion(input.expectedVersion);
  const now = validNow(input.now);

  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:submission:${input.applicationId}`}, 0))`;
    const replay = await tx.submissionAuthorization.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey }, include: { application: true } });
    if (replay) {
      if (replay.applicationId !== input.applicationId || replay.applicationVersion !== input.expectedVersion || replay.correlationId !== input.correlationId) {
        throw new SubmissionEngineError('CONFLICT', 'Idempotency key was used for a different submission authorization');
      }
      const automationJob = await tx.automationJob.findFirst({ where: { userId: input.userId, idempotencyKey: `authorized-submission:${replay.id}` } });
      if (!automationJob) throw new SubmissionEngineError('CONFLICT', 'Submission authorization has no execution command');
      return { authorization: replay, automationJob, replayed: true as const };
    }

    const application = await tx.application.findFirst({
      where: { id: input.applicationId, userId: input.userId },
      include: { documents: { where: { type: 'cover_letter' }, include: { objectMetadata: true } }, resumeVersion: { include: { objectMetadata: true, resume: { include: { objectMetadata: true } } } }, questionsNormalized: { include: { answers: true } }, automationRun: true },
    });
    if (!application) throw new SubmissionEngineError('NOT_FOUND', 'Application not found');
    if (application.version !== input.expectedVersion) throw new SubmissionEngineError('STALE_VERSION', 'Application version is stale');
    if (application.status !== 'READY_TO_SUBMIT') throw new SubmissionEngineError('PRECONDITION_FAILED', 'Application is not ready for explicit submission authorization');

    const [quality, activeVerification, approvedFacts, activeAuthorization] = await Promise.all([
      tx.applicationQualityDecision.findFirst({ where: { applicationId: application.id, userId: input.userId, decision: 'PASS' }, orderBy: { createdAt: 'desc' } }),
      tx.humanVerification.findFirst({ where: { applicationId: application.id, userId: input.userId, status: { in: activeVerificationStatuses } } }),
      tx.resumeSourceFact.findMany({ where: { userId: input.userId, resumeId: application.resumeVersion.resumeId, approved: true }, select: { id: true, checksum: true } }),
      tx.submissionAuthorization.findFirst({ where: { userId: input.userId, applicationId: application.id, status: { in: ['AUTHORIZED', 'EXECUTING', 'OUTCOME_UNKNOWN'] } } }),
    ]);
    if (!quality) throw new SubmissionEngineError('PRECONDITION_FAILED', 'A passing application quality decision is required');
    if (activeVerification) throw new SubmissionEngineError('PRECONDITION_FAILED', 'Human verification is pending or expired');
    if (activeAuthorization) throw new SubmissionEngineError('CONFLICT', 'A submission authorization is already active');
    if (application.automationRun?.mode && application.automationRun.mode !== 'SMART_AUTO') {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'The automation run is not explicitly authorized for automatic submission');
    }

    const provenance = evidenceFacts(application.resumeVersion.sourceFacts, approvedFacts);
    if (!provenance.valid || !application.resumeVersion.content.trim() || application.resumeVersion.atsScoreData === null) {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'Resume version lacks approved fact provenance or ATS evidence');
    }
    const document = application.resumeVersion.objectMetadata;
    const exactDocument = document?.resumeVersionId === application.resumeVersionId;
    const approvedResumeArtifact = document && ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'].includes(document.kind);
    if (!document || !exactDocument || !approvedResumeArtifact || document.userId !== input.userId
      || !document.objectKey.startsWith('private/') || !/^[a-f0-9]{64}$/i.test(document.checksumSha256)
      || document.approvalStatus !== 'APPROVED' || !document.approvedAt || document.approvedBy !== input.userId
      || document.scanStatus !== 'CLEAN' || !document.encryptionKeyRef || document.deletedAt || (document.expiresAt && document.expiresAt <= now)) {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'Required resume document is unavailable, expired, or not clean');
    }
    try {
      validateStoredDocumentMetadata(document, { userId: input.userId, kinds: ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'] });
    } catch (error) {
      if (error instanceof DocumentStorageError) throw new SubmissionEngineError('PRECONDITION_FAILED', 'Required resume document metadata is invalid');
      throw error;
    }
    const coverLetterDocuments = application.documents ?? [];
    if (coverLetterDocuments.length > 1) throw new SubmissionEngineError('PRECONDITION_FAILED', 'Application has ambiguous cover-letter document attachments');
    const coverLetterDocument = coverLetterDocuments[0]?.objectMetadata;
    if (coverLetterDocument) {
      if (coverLetterDocument.userId !== input.userId || coverLetterDocument.resumeVersionId !== application.resumeVersionId || coverLetterDocument.kind !== 'COVER_LETTER'
          || coverLetterDocument.approvalStatus !== 'APPROVED' || !coverLetterDocument.approvedAt || coverLetterDocument.approvedBy !== input.userId
        || coverLetterDocument.scanStatus !== 'CLEAN'
        || coverLetterDocument.deletedAt || (coverLetterDocument.expiresAt && coverLetterDocument.expiresAt <= now)) {
        throw new SubmissionEngineError('PRECONDITION_FAILED', 'Cover-letter document is unavailable, expired, or not clean');
      }
      try {
        validateStoredDocumentMetadata(coverLetterDocument, { userId: input.userId, kinds: ['COVER_LETTER'] });
      } catch (error) {
        if (error instanceof DocumentStorageError) throw new SubmissionEngineError('PRECONDITION_FAILED', 'Cover-letter document metadata is invalid');
        throw error;
      }
    }
    if (application.questionsNormalized.some(question => question.required && !selectReviewedApplicationAnswer(question.answers, input.userId))) {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'A required application answer lacks reviewed provenance');
    }

    const expiresAt = new Date(now.getTime() + authorizationLifetimeMs);
    const authorization = await tx.submissionAuthorization.create({ data: {
      userId: input.userId, applicationId: application.id, applicationVersion: application.version, resumeVersionId: application.resumeVersionId,
      preflightEvidence: {
        qualityDecisionId: quality.id, qualityInputHash: quality.inputHash, resumeVersionId: application.resumeVersionId,
        resumeSourceFactIds: provenance.sourceFactIds, resumeDocument: documentReference(document),
        coverLetterDocument: coverLetterDocument ? documentReference(coverLetterDocument) : null,
        requiredQuestionIds: application.questionsNormalized.filter(question => question.required).map(question => question.id),
        verifiedAt: now.toISOString(),
      },
      expiresAt, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    } });
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: application.id, userId: input.userId, toStatus: 'SUBMISSION_PENDING', expectedVersion: application.version,
      actorType: 'USER', actorId: input.userId, reason: 'User explicitly authorized the reviewed application submission',
      idempotencyKey: `submission-authorization-transition:${authorization.id}`, correlationId: input.correlationId,
      metadata: { authorizationId: authorization.id, resumeVersionId: application.resumeVersionId, expiresAt: expiresAt.toISOString() },
    });
    const automationJob = await tx.automationJob.create({ data: {
      userId: input.userId, applicationId: application.id, type: 'EXECUTE_AUTHORIZED_SUBMISSION', status: 'AVAILABLE', payload: { authorizationId: authorization.id },
      payloadVersion: 1, maxAttempts: 1, correlationId: input.correlationId, idempotencyKey: `authorized-submission:${authorization.id}`,
    } });
    await Promise.all([
      tx.auditLog.create({ data: { userId: input.userId, action: 'SUBMISSION_AUTHORIZED', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: application.id, applicationVersion: authorization.applicationVersion, expiresAt: expiresAt.toISOString() } } }),
      tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'SubmissionAuthorization', aggregateId: authorization.id, eventType: 'submission.authorized', payload: { applicationId: application.id, authorizationId: authorization.id, applicationVersion: authorization.applicationVersion }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `submission-authorized:${authorization.id}` } }),
    ]);
    return { authorization, automationJob, application: transitioned.application, replayed: false as const };
  });
}

async function claimAuthorizedSubmission(input: ExecuteAuthorizedSubmissionInput) {
  const now = validNow(input.now);
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:submission-authorization:${input.authorizationId}`}, 0))`;
    const authorization = await tx.submissionAuthorization.findFirst({ where: { id: input.authorizationId, userId: input.userId }, include: { application: true } });
    if (!authorization) throw new SubmissionEngineError('NOT_FOUND', 'Submission authorization not found');
    if (authorization.status === 'CONSUMED') return { authorization, replayed: true as const };
    if (authorization.status === 'OUTCOME_UNKNOWN') throw new SubmissionEngineError('UNKNOWN_OUTCOME', 'The prior authorized provider submission has an unknown outcome and must be independently reconciled');
    if (authorization.status !== 'AUTHORIZED' || authorization.expiresAt <= now) {
      if (authorization.status === 'AUTHORIZED') await tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'EXPIRED' } });
      throw new SubmissionEngineError('EXPIRED', 'Submission authorization has expired');
    }
    if (authorization.application.status !== 'SUBMISSION_PENDING' || authorization.application.version !== authorization.applicationVersion + 1) {
      throw new SubmissionEngineError('CONFLICT', 'Application no longer matches its authorized submission');
    }
    const executing = await tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'EXECUTING' } });
    const latestAttempt = await tx.applicationAttempt.findFirst({
      where: { applicationId: authorization.applicationId },
      orderBy: { attemptNumber: 'desc' },
      select: { attemptNumber: true },
    });
    const attempt = await tx.applicationAttempt.create({
      data: {
        applicationId: authorization.applicationId,
        attemptNumber: (latestAttempt?.attemptNumber ?? 0) + 1,
        status: 'EXECUTING',
        // Bind the durable start time to the operation clock used by all
        // completion paths; a later database default can otherwise make a
        // fast failure appear to finish before it started.
        startedAt: now,
        logs: [{ event: 'submission_execution_started', authorizationId: authorization.id, correlationId: input.correlationId, workerId: input.workerId, ...authorizedDocumentEvidence(authorization.preflightEvidence) }],
      },
      select: { id: true },
    });
    return { authorization: executing, attemptId: attempt.id, replayed: false as const };
  });
}

export async function executeAuthorizedSubmission(input: ExecuteAuthorizedSubmissionInput, executor: SubmissionExecutor = new ProviderSubmissionService()) {
  requireText(input.userId, 'userId');
  requireText(input.authorizationId, 'authorizationId');
  requireText(input.correlationId, 'correlationId');
  requireText(input.workerId, 'workerId');
  const now = validNow(input.now);
  const claimed = await claimAuthorizedSubmission({ ...input, now });
  if (claimed.replayed) return claimed;

  let providerExecutionCompleted = false;
  try {
    const result = await executor.execute({ userId: input.userId, applicationId: claimed.authorization.applicationId, authorizationId: claimed.authorization.id, correlationId: input.correlationId, workerId: input.workerId });
    providerExecutionCompleted = true;
    validateProviderExecutionResult(result, claimed.authorization.applicationId);
    return withTenant(input.userId, async tx => {
      const authorization = await tx.submissionAuthorization.findFirst({ where: { id: claimed.authorization.id, userId: input.userId }, include: { application: true } });
      if (!authorization || authorization.status !== 'EXECUTING') throw new SubmissionEngineError('CONFLICT', 'Submission authorization is no longer executing');
      if (authorization.application.status !== 'SUBMISSION_PENDING' || authorization.application.version !== authorization.applicationVersion + 1) throw new SubmissionEngineError('CONFLICT', 'Application changed during provider submission');
      const transitioned = await transitionApplicationInTenant(tx, {
        applicationId: authorization.applicationId, userId: input.userId, toStatus: 'UNCONFIRMED', expectedVersion: authorization.application.version,
        actorType: 'WORKER', reason: 'Provider submit control was activated; independent confirmation is still required',
        idempotencyKey: `submission-attempt-unconfirmed:${authorization.id}`, correlationId: input.correlationId,
        effectiveAt: result.attemptedAt,
        metadata: { authorizationId: authorization.id, provider: result.provider, attemptedAt: result.attemptedAt.toISOString() },
      });
      const updated = await tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'CONSUMED', consumedAt: now } });
      if (result.confirmation) {
        await tx.automationJob.create({ data: {
          userId: input.userId,
          applicationId: authorization.applicationId,
          type: 'VERIFY_SUBMISSION_CONFIRMATION',
          status: 'AVAILABLE',
          payload: { ...result.confirmation, attemptId: claimed.attemptId, observedAt: result.confirmation.observedAt.toISOString() } as unknown as Prisma.InputJsonValue,
          payloadVersion: 1,
          maxAttempts: 1,
          correlationId: input.correlationId,
          idempotencyKey: `verify-submission:${authorization.id}:${result.confirmation.evidenceHash}`,
        } });
      }
      await Promise.all([
        tx.applicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: 'UNCONFIRMED', completedAt: result.attemptedAt, logs: [{ event: 'provider_submit_activated', authorizationId: authorization.id, correlationId: input.correlationId, provider: result.provider, attemptedAt: result.attemptedAt.toISOString(), independentlyConfirmed: false, ...authorizedDocumentEvidence(authorization.preflightEvidence) }] } }),
        tx.auditLog.create({ data: { userId: input.userId, action: 'SUBMISSION_ATTEMPTED', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: authorization.applicationId, provider: result.provider, attemptedAt: result.attemptedAt.toISOString(), independentlyConfirmed: false } } }),
        tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'SubmissionAuthorization', aggregateId: authorization.id, eventType: 'submission.attempted', payload: { applicationId: authorization.applicationId, authorizationId: authorization.id, provider: result.provider, independentlyConfirmed: false }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `submission-attempted:${authorization.id}` } }),
      ]);
      return { authorization: updated, application: transitioned.application, replayed: false as const };
    });
  } catch (error) {
    if (error instanceof ProviderSubmissionError && error.code === 'HUMAN_VERIFICATION_REQUIRED') {
      await withTenant(input.userId, async tx => {
        const authorization = await tx.submissionAuthorization.findFirst({ where: { id: claimed.authorization.id, userId: input.userId, status: 'EXECUTING' } });
        if (!authorization) return;
        await Promise.all([
          tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'FAILED', consumedAt: now } }),
          tx.applicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: 'WAITING_FOR_USER', completedAt: now, error: 'Human verification required before re-authorization', logs: [{ event: 'submission_paused_for_human_verification', authorizationId: authorization.id, correlationId: input.correlationId, humanVerificationRequired: true, ...authorizedDocumentEvidence(claimed.authorization.preflightEvidence) }] } }),
          tx.auditLog.create({ data: { userId: input.userId, action: 'SUBMISSION_PAUSED_FOR_HUMAN_VERIFICATION', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: authorization.applicationId, correlationId: input.correlationId } } }),
        ]);
      });
      throw error;
    }
    const unknown = error instanceof ProviderSubmissionError && error.code === 'UNKNOWN_OUTCOME';
    // Once the provider executor returns, the browser may already have
    // activated submit. Any persistence failure after that point cannot be
    // safely classified as a normal provider rejection.
    if (!unknown && !providerExecutionCompleted) {
      await withTenant(input.userId, async tx => {
        const authorization = await tx.submissionAuthorization.findFirst({ where: { id: claimed.authorization.id, userId: input.userId, status: 'EXECUTING' }, include: { application: true } });
        if (!authorization) return;
        const completedAt = now;
        const retryable = !(error instanceof ProviderSubmissionError);
        if (authorization.application.status === 'SUBMISSION_PENDING') {
          await transitionApplicationInTenant(tx, {
            applicationId: authorization.applicationId, userId: input.userId, toStatus: 'FAILED', expectedVersion: authorization.application.version,
            actorType: 'WORKER', reason: 'Provider submission failed before an outcome was established',
            idempotencyKey: `submission-failed:${authorization.id}`, correlationId: input.correlationId,
            metadata: { authorizationId: authorization.id, independentlyConfirmed: false },
          });
        }
        await tx.applicationAttempt.update({
          where: { id: claimed.attemptId },
          data: {
            status: 'FAILED',
            completedAt,
            error: safeSubmissionFailureMessage(error),
            logs: [{ event: 'submission_execution_failed', authorizationId: claimed.authorization.id, correlationId: input.correlationId, ...authorizedDocumentEvidence(claimed.authorization.preflightEvidence) }],
          },
        });
        await Promise.all([
          tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'FAILED', consumedAt: completedAt } }),
          tx.failureRecord.create({ data: { userId: input.userId, applicationId: authorization.applicationId, category: 'SUBMISSION', code: 'PROVIDER_FAILURE', message: safeSubmissionFailureMessage(error), retryable, details: { authorizationId: authorization.id, ...authorizedDocumentEvidence(authorization.preflightEvidence) }, correlationId: input.correlationId } }),
          tx.auditLog.create({ data: { userId: input.userId, action: 'SUBMISSION_FAILED', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: authorization.applicationId, independentlyConfirmed: false } } }),
        ]);
      });
      throw error;
    }
    await withTenant(input.userId, async tx => {
      const authorization = await tx.submissionAuthorization.findFirst({ where: { id: input.authorizationId, userId: input.userId, status: 'EXECUTING' }, include: { application: true } });
      if (!authorization) return;
      if (authorization.application.status === 'SUBMISSION_PENDING') {
        await transitionApplicationInTenant(tx, {
          applicationId: authorization.applicationId, userId: input.userId, toStatus: 'UNCONFIRMED', expectedVersion: authorization.application.version,
          actorType: 'WORKER', reason: 'Provider submission may have activated submit; independent confirmation is required',
          idempotencyKey: `submission-unknown-transition:${authorization.id}`, correlationId: input.correlationId,
          metadata: { authorizationId: authorization.id, independentlyConfirmed: false },
        });
      }
      await Promise.all([
        tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'OUTCOME_UNKNOWN' } }),
        tx.applicationAttempt.update({ where: { id: claimed.attemptId }, data: { status: 'OUTCOME_UNKNOWN', completedAt: now, error: 'Provider submission outcome is unknown', logs: [{ event: 'provider_submit_outcome_unknown', authorizationId: authorization.id, correlationId: input.correlationId, independentlyConfirmed: false, ...authorizedDocumentEvidence(authorization.preflightEvidence) }] } }),
        tx.failureRecord.create({ data: { userId: input.userId, applicationId: authorization.applicationId, category: 'SUBMISSION', code: 'OUTCOME_UNKNOWN', message: 'Provider submission outcome is unknown; automatic retry is forbidden', retryable: false, details: { authorizationId: authorization.id, ...authorizedDocumentEvidence(authorization.preflightEvidence) }, correlationId: input.correlationId } }),
        tx.auditLog.create({ data: { userId: input.userId, action: 'SUBMISSION_OUTCOME_UNKNOWN', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: authorization.applicationId, ...authorizedDocumentEvidence(authorization.preflightEvidence) } } }),
        tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'SubmissionAuthorization', aggregateId: authorization.id, eventType: 'submission.outcome.unknown', payload: { applicationId: authorization.applicationId, authorizationId: authorization.id, independentlyConfirmed: false }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `submission-outcome-unknown:${authorization.id}` } }),
      ]);
    });
    throw new SubmissionEngineError('UNKNOWN_OUTCOME', 'Provider submission outcome is unknown; automatic retry is forbidden');
  }
}

/** Convert abandoned provider executions to an explicit unknown outcome after a bounded crash window. */
export async function reconcileStaleSubmissionAuthorizations(now = new Date(), staleAfterMs = 15 * 60 * 1000): Promise<number> {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) throw new Error('staleAfterMs must be at least one minute');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SubmissionEngineError('INVALID', 'Submission reconciliation time must be a valid Date');
  const before = new Date(now.getTime() - staleAfterMs);
  // Recovery is worker-wide; enumerate candidates through the maintenance
  // connection so tenant RLS cannot hide stale executions from reconciliation.
  const candidates = await withService((tx) => tx.submissionAuthorization.findMany({ where: { status: 'EXECUTING' }, select: { id: true, userId: true } }));
  let reconciled = 0;
  for (const candidate of candidates) {
    reconciled += await withTenant(candidate.userId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${candidate.userId}:submission-authorization:${candidate.id}`}, 0))`;
      const authorization = await tx.submissionAuthorization.findFirst({ where: { id: candidate.id, userId: candidate.userId, status: 'EXECUTING' }, include: { application: true } });
      if (!authorization) return 0;
      const attempt = await tx.applicationAttempt.findFirst({ where: { applicationId: authorization.applicationId, status: 'EXECUTING', startedAt: { lte: before } }, orderBy: { startedAt: 'desc' } });
      if (!attempt) return 0;
      if (authorization.application.status === 'SUBMISSION_PENDING') {
        await transitionApplicationInTenant(tx, {
          applicationId: authorization.applicationId, userId: candidate.userId, toStatus: 'UNCONFIRMED', expectedVersion: authorization.application.version,
          actorType: 'SYSTEM', reason: 'Submission worker execution became stale; independent confirmation is required',
          idempotencyKey: `submission-stale:${authorization.id}`, correlationId: authorization.correlationId,
          metadata: { authorizationId: authorization.id, staleAt: now.toISOString(), independentlyConfirmed: false },
        });
      }
      await Promise.all([
        tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'OUTCOME_UNKNOWN' } }),
        tx.applicationAttempt.update({ where: { id: attempt.id }, data: { status: 'OUTCOME_UNKNOWN', completedAt: now, error: 'Submission worker became stale before outcome was known', logs: [{ event: 'stale_submission_reconciled', authorizationId: authorization.id, correlationId: authorization.correlationId, independentlyConfirmed: false, ...authorizedDocumentEvidence(authorization.preflightEvidence) }] } }),
        tx.failureRecord.create({ data: { userId: candidate.userId, applicationId: authorization.applicationId, category: 'SUBMISSION', code: 'STALE_EXECUTION', message: 'Submission execution became stale; automatic retry is forbidden', retryable: false, details: { authorizationId: authorization.id, ...authorizedDocumentEvidence(authorization.preflightEvidence) }, correlationId: authorization.correlationId } }),
        tx.auditLog.create({ data: { userId: candidate.userId, action: 'STALE_SUBMISSION_RECONCILED', resource: 'SubmissionAuthorization', resourceId: authorization.id, details: { applicationId: authorization.applicationId, independentlyConfirmed: false } } }),
        ...(authorization.application.status === 'SUBMISSION_PENDING' ? [] : [tx.outboxEvent.create({ data: { userId: candidate.userId, aggregateType: 'SubmissionAuthorization', aggregateId: authorization.id, eventType: 'submission.outcome.unknown', payload: { applicationId: authorization.applicationId, authorizationId: authorization.id, independentlyConfirmed: false }, schemaVersion: 1, correlationId: authorization.correlationId, idempotencyKey: `submission-outcome-unknown:${authorization.id}` } })]),
      ]);
      return 1;
    });
  }
  return reconciled;
}

/** Compatibility alias for the automation handler; it now performs the actual authorized submission. */
export async function recordAuthorizedSubmissionHandoff(input: Omit<ExecuteAuthorizedSubmissionInput, 'workerId'> & { workerId?: string }) {
  return executeAuthorizedSubmission({ ...input, workerId: input.workerId ?? 'compatibility-submission-worker' });
}
