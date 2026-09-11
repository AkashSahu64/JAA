import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';

export class ApplicationCreationError extends Error {
  constructor(
    public readonly code: 'INVALID' | 'NOT_FOUND' | 'PREREQUISITES_MISSING' | 'APPLICATION_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationCreationError';
  }
}

export interface CreateApplicationIntentInput {
  userId: string;
  jobId: string;
  resumeVersionId: string;
  searchProfileId: string;
  correlationId: string;
  idempotencyKey: string;
  automationRunId?: string;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new ApplicationCreationError('INVALID', `${name} is required`);
}

function payloadMatches(
  payload: Prisma.JsonValue,
  expected: { applicationId: string; searchProfileId: string },
): boolean {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).applicationId === expected.applicationId
    && (payload as Record<string, unknown>).searchProfileId === expected.searchProfileId);
}

function hasVerifiedProvenance(value: Prisma.JsonValue): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).sourceFactId === 'string'
    && typeof (item as Record<string, unknown>).sourceChecksum === 'string');
}

export async function createApplicationIntent(input: CreateApplicationIntentInput) {
  requireText(input.userId, 'userId');
  requireText(input.jobId, 'jobId');
  requireText(input.resumeVersionId, 'resumeVersionId');
  requireText(input.searchProfileId, 'searchProfileId');
  requireText(input.correlationId, 'correlationId');
  requireText(input.idempotencyKey, 'idempotencyKey');

  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:application-create:${input.jobId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:application-create:${input.idempotencyKey}`}, 0))`;
    const existing = await tx.application.findFirst({
      where: { userId: input.userId, jobId: input.jobId },
      include: { jobs: { where: { idempotencyKey: input.idempotencyKey }, take: 1 } },
    });
    if (existing) {
      const queued = existing.jobs[0];
      if (existing.resumeVersionId === input.resumeVersionId && queued
        && queued.correlationId === input.correlationId
        && queued.automationRunId === (input.automationRunId ?? null)
        && queued.type === 'EVALUATE_APPLICATION_QUALITY'
        && payloadMatches(queued.payload, { applicationId: existing.id, searchProfileId: input.searchProfileId })) {
        return { application: existing, automationJob: queued, replayed: true as const };
      }
      throw new ApplicationCreationError('APPLICATION_EXISTS', 'An application already exists for this job');
    }

    const [job, version, profile, match, run] = await Promise.all([
      tx.job.findUnique({ where: { id: input.jobId }, select: { id: true, isActive: true } }),
      tx.resumeVersion.findFirst({ where: { id: input.resumeVersionId, resume: { userId: input.userId } }, select: { id: true, jobId: true, content: true, atsScoreData: true, sourceFacts: true } }),
      tx.searchProfile.findFirst({ where: { id: input.searchProfileId, userId: input.userId, isActive: true }, select: { id: true } }),
      tx.jobMatch.findFirst({ where: { userId: input.userId, jobId: input.jobId }, select: { id: true } }),
      input.automationRunId ? tx.automationRun.findFirst({ where: { id: input.automationRunId, userId: input.userId }, select: { id: true } }) : Promise.resolve(null),
    ]);
    if (!job || !version || !profile || (input.automationRunId && !run)) {
      throw new ApplicationCreationError('NOT_FOUND', 'Job, resume version, active search profile, or automation run was not found');
    }
    if (!job.isActive || version.jobId !== input.jobId || !version.content.trim() || version.atsScoreData === null || !hasVerifiedProvenance(version.sourceFacts) || !match) {
      throw new ApplicationCreationError('PREREQUISITES_MISSING', 'An active job, matching fact-verified resume version, ATS evidence, and job match are required');
    }

    const application = await tx.application.create({
      data: {
        userId: input.userId,
        jobId: input.jobId,
        resumeVersionId: input.resumeVersionId,
        automationRunId: input.automationRunId,
      },
    });
    const automationJob = await tx.automationJob.create({
      data: {
        userId: input.userId,
        applicationId: application.id,
        automationRunId: input.automationRunId,
        type: 'EVALUATE_APPLICATION_QUALITY',
        status: 'AVAILABLE',
        payload: { applicationId: application.id, searchProfileId: input.searchProfileId },
        payloadVersion: 1,
        maxAttempts: 3,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await Promise.all([
      tx.auditLog.create({
        data: {
          userId: input.userId,
          action: 'APPLICATION_CREATED',
          resource: 'Application',
          resourceId: application.id,
          details: { jobId: input.jobId, resumeVersionId: input.resumeVersionId, searchProfileId: input.searchProfileId, automationJobId: automationJob.id },
        },
      }),
      tx.outboxEvent.create({
        data: {
          userId: input.userId,
          aggregateType: 'Application',
          aggregateId: application.id,
          eventType: 'application.created',
          payload: { jobId: input.jobId, resumeVersionId: input.resumeVersionId, searchProfileId: input.searchProfileId, automationJobId: automationJob.id },
          schemaVersion: 1,
          correlationId: input.correlationId,
          idempotencyKey: `application-created:${input.userId}:${input.idempotencyKey}`,
        },
      }),
    ]);
    return { application, automationJob, replayed: false as const };
  });
}
