import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';

const authorizationLifetimeMs = 10 * 60 * 1000;
const activeVerificationStatuses = ['PENDING', 'EXPIRED'];

export class SubmissionEngineError extends Error {
  constructor(
    public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'STALE_VERSION' | 'PRECONDITION_FAILED' | 'EXPIRED',
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

export interface RecordSubmissionHandoffInput {
  userId: string;
  authorizationId: string;
  correlationId: string;
  now?: Date;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new SubmissionEngineError('INVALID', `${name} is required`);
}

function requireVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SubmissionEngineError('STALE_VERSION', 'expectedVersion must be a positive integer');
  }
}

function evidenceFacts(
  sourceFacts: Prisma.JsonValue,
  approvedFacts: Array<{ id: string; checksum: string }>,
): { valid: boolean; sourceFactIds: string[] } {
  if (!Array.isArray(sourceFacts) || sourceFacts.length === 0) return { valid: false, sourceFactIds: [] };
  const approved = new Map(approvedFacts.map(fact => [fact.id, fact.checksum]));
  const sourceFactIds: string[] = [];
  for (const source of sourceFacts) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return { valid: false, sourceFactIds: [] };
    const value = source as Record<string, unknown>;
    if (typeof value.sourceFactId !== 'string' || typeof value.sourceChecksum !== 'string'
      || approved.get(value.sourceFactId) !== value.sourceChecksum) return { valid: false, sourceFactIds: [] };
    sourceFactIds.push(value.sourceFactId);
  }
  return { valid: true, sourceFactIds };
}

function reviewedAnswer(answer: { approved: boolean; provenance: Prisma.JsonValue } | null): boolean {
  return answer?.approved === true && !!answer.provenance
    && typeof answer.provenance === 'object' && !Array.isArray(answer.provenance);
}

export async function authorizeSubmission(input: AuthorizeSubmissionInput) {
  requireText(input.userId, 'userId');
  requireText(input.applicationId, 'applicationId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  requireText(input.correlationId, 'correlationId');
  requireVersion(input.expectedVersion);
  const now = input.now ?? new Date();

  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:submission:${input.applicationId}`}, 0))`;
    const replay = await tx.submissionAuthorization.findFirst({
      where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
      include: { application: true },
    });
    if (replay) {
      if (replay.applicationId !== input.applicationId || replay.applicationVersion !== input.expectedVersion
        || replay.correlationId !== input.correlationId) {
        throw new SubmissionEngineError('CONFLICT', 'Idempotency key was used for a different submission authorization');
      }
      const automationJob = await tx.automationJob.findFirst({
        where: { userId: input.userId, idempotencyKey: `submission-handoff:${replay.id}` },
      });
      if (!automationJob) throw new SubmissionEngineError('CONFLICT', 'Submission authorization has no handoff command');
      return { authorization: replay, automationJob, replayed: true as const };
    }

    const application = await tx.application.findFirst({
      where: { id: input.applicationId, userId: input.userId },
      include: {
        resumeVersion: { include: { resume: { include: { objectMetadata: true } } } },
        questionsNormalized: { include: { answers: true } },
      },
    });
    if (!application) throw new SubmissionEngineError('NOT_FOUND', 'Application not found');
    if (application.version !== input.expectedVersion) throw new SubmissionEngineError('STALE_VERSION', 'Application version is stale');
    if (application.status !== 'READY_TO_SUBMIT') {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'Application is not ready for explicit submission authorization');
    }

    const [quality, activeVerification, approvedFacts, existingHandoff] = await Promise.all([
      tx.applicationQualityDecision.findFirst({ where: { applicationId: application.id, userId: input.userId, decision: 'PASS' }, orderBy: { createdAt: 'desc' } }),
      tx.humanVerification.findFirst({ where: { applicationId: application.id, userId: input.userId, status: { in: activeVerificationStatuses } } }),
      tx.resumeSourceFact.findMany({ where: { userId: input.userId, resumeId: application.resumeVersion.resumeId, approved: true }, select: { id: true, checksum: true } }),
      tx.automationJob.findFirst({ where: { applicationId: application.id, userId: input.userId, type: 'RECORD_AUTHORIZED_SUBMISSION_HANDOFF', status: { in: ['PENDING', 'AVAILABLE', 'LEASED'] } } }),
    ]);
    if (!quality) throw new SubmissionEngineError('PRECONDITION_FAILED', 'A passing application quality decision is required');
    if (activeVerification) throw new SubmissionEngineError('PRECONDITION_FAILED', 'Human verification is pending or expired');
    if (existingHandoff) throw new SubmissionEngineError('CONFLICT', 'A submission handoff is already in progress');

    const provenance = evidenceFacts(application.resumeVersion.sourceFacts, approvedFacts);
    if (!provenance.valid || !application.resumeVersion.content.trim() || application.resumeVersion.atsScoreData === null) {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'Resume version lacks approved fact provenance or ATS evidence');
    }
    const document = application.resumeVersion.resume.objectMetadata;
    if (!document || document.userId !== input.userId || document.scanStatus !== 'CLEAN' || document.deletedAt
      || (document.expiresAt && document.expiresAt <= now)) {
      throw new SubmissionEngineError('PRECONDITION_FAILED', 'Required resume document is unavailable, expired, or not clean');
    }
    const unanswered = application.questionsNormalized.find(question => question.required && !reviewedAnswer(question.answers[0] ?? null));
    if (unanswered) throw new SubmissionEngineError('PRECONDITION_FAILED', 'A required application answer lacks reviewed provenance');

    const expiresAt = new Date(now.getTime() + authorizationLifetimeMs);
    const preflightEvidence = {
      qualityDecisionId: quality.id,
      qualityInputHash: quality.inputHash,
      resumeVersionId: application.resumeVersionId,
      resumeSourceFactIds: provenance.sourceFactIds,
      resumeDocument: { id: document.id, checksumSha256: document.checksumSha256, scanStatus: document.scanStatus },
      requiredQuestionIds: application.questionsNormalized.filter(question => question.required).map(question => question.id),
      verifiedAt: now.toISOString(),
    } satisfies Prisma.InputJsonObject;
    const authorization = await tx.submissionAuthorization.create({
      data: {
        userId: input.userId,
        applicationId: application.id,
        applicationVersion: application.version,
        resumeVersionId: application.resumeVersionId,
        preflightEvidence,
        expiresAt,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      },
    });
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: application.id,
      userId: input.userId,
      toStatus: 'SUBMISSION_PENDING',
      expectedVersion: application.version,
      actorType: 'USER',
      actorId: input.userId,
      reason: 'User explicitly authorized the reviewed application handoff',
      idempotencyKey: `submission-authorization-transition:${authorization.id}`,
      correlationId: input.correlationId,
      metadata: { authorizationId: authorization.id, resumeVersionId: application.resumeVersionId, expiresAt: expiresAt.toISOString() },
    });
    const automationJob = await tx.automationJob.create({
      data: {
        userId: input.userId,
        applicationId: application.id,
        type: 'RECORD_AUTHORIZED_SUBMISSION_HANDOFF',
        status: 'AVAILABLE',
        payload: { authorizationId: authorization.id },
        payloadVersion: 1,
        maxAttempts: 1,
        correlationId: input.correlationId,
        idempotencyKey: `submission-handoff:${authorization.id}`,
      },
    });
    await Promise.all([
      tx.auditLog.create({
        data: {
          userId: input.userId,
          action: 'SUBMISSION_AUTHORIZED',
          resource: 'SubmissionAuthorization',
          resourceId: authorization.id,
          details: { applicationId: application.id, applicationVersion: authorization.applicationVersion, expiresAt: expiresAt.toISOString() },
        },
      }),
      tx.outboxEvent.create({
        data: {
          userId: input.userId,
          aggregateType: 'SubmissionAuthorization',
          aggregateId: authorization.id,
          eventType: 'submission.authorized',
          payload: { applicationId: application.id, authorizationId: authorization.id, applicationVersion: authorization.applicationVersion },
          schemaVersion: 1,
          correlationId: input.correlationId,
          idempotencyKey: `submission-authorized:${authorization.id}`,
        },
      }),
    ]);
    return { authorization, automationJob, application: transitioned.application, replayed: false as const };
  });
}

/** Records an authorized handoff only; it intentionally never clicks a provider submit control. */
export async function recordAuthorizedSubmissionHandoff(input: RecordSubmissionHandoffInput) {
  requireText(input.userId, 'userId');
  requireText(input.authorizationId, 'authorizationId');
  requireText(input.correlationId, 'correlationId');
  const now = input.now ?? new Date();
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:submission-authorization:${input.authorizationId}`}, 0))`;
    const authorization = await tx.submissionAuthorization.findFirst({
      where: { id: input.authorizationId, userId: input.userId },
      include: { application: true },
    });
    if (!authorization) throw new SubmissionEngineError('NOT_FOUND', 'Submission authorization not found');
    if (authorization.status === 'CONSUMED') return { authorization, replayed: true as const };
    if (authorization.status !== 'AUTHORIZED' || authorization.expiresAt <= now) {
      if (authorization.status === 'AUTHORIZED') {
        await tx.submissionAuthorization.update({ where: { id: authorization.id }, data: { status: 'EXPIRED' } });
      }
      throw new SubmissionEngineError('EXPIRED', 'Submission authorization has expired');
    }
    if (authorization.application.status !== 'SUBMISSION_PENDING'
      || authorization.application.version !== authorization.applicationVersion + 1) {
      throw new SubmissionEngineError('CONFLICT', 'Application no longer matches its authorized submission handoff');
    }
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: authorization.applicationId,
      userId: input.userId,
      toStatus: 'UNCONFIRMED',
      expectedVersion: authorization.application.version,
      actorType: 'WORKER',
      reason: 'Authorized submission handoff completed; provider outcome remains unconfirmed',
      idempotencyKey: `submission-handoff-unconfirmed:${authorization.id}`,
      correlationId: input.correlationId,
      metadata: { authorizationId: authorization.id, providerSubmissionAttempted: false },
    });
    const updated = await tx.submissionAuthorization.update({
      where: { id: authorization.id },
      data: { status: 'CONSUMED', consumedAt: now },
    });
    await Promise.all([
      tx.auditLog.create({
        data: {
          userId: input.userId,
          action: 'SUBMISSION_HANDOFF_RECORDED',
          resource: 'SubmissionAuthorization',
          resourceId: authorization.id,
          details: { applicationId: authorization.applicationId, providerSubmissionAttempted: false },
        },
      }),
      tx.outboxEvent.create({
        data: {
          userId: input.userId,
          aggregateType: 'SubmissionAuthorization',
          aggregateId: authorization.id,
          eventType: 'submission.handoff-recorded',
          payload: { applicationId: authorization.applicationId, authorizationId: authorization.id, providerSubmissionAttempted: false },
          schemaVersion: 1,
          correlationId: input.correlationId,
          idempotencyKey: `submission-handoff-recorded:${authorization.id}`,
        },
      }),
    ]);
    return { authorization: updated, application: transitioned.application, replayed: false as const };
  });
}
