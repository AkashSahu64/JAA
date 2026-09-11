import { Prisma, JobStatus, type AutomationJob } from '@prisma/client';
import { prisma, withTenant } from '@jobagent/database';

export interface CreateAutomationJobInput {
  userId: string;
  applicationId?: string;
  automationRunId?: string;
  type: string;
  priority?: number;
  payload: Prisma.InputJsonValue;
  payloadVersion?: number;
  maxAttempts?: number;
  availableAt?: Date;
  correlationId: string;
  idempotencyKey: string;
}

export interface ReplayAutomationJobInput {
  jobId: string;
  userId: string;
  reason: string;
  correlationId: string;
  maxAttempts?: number;
}

export interface ClaimAutomationJobsInput {
  workerId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
}

export interface OwnedAutomationJobInput {
  jobId: string;
  workerId: string;
  now?: Date;
}

export interface LeaseAutomationJobInput extends OwnedAutomationJobInput {
  leaseMs?: number;
  expectedAttempt?: number;
  deliveryGeneration?: number;
}

export class AutomationJobError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'LEASE_LOST' | 'TERMINAL' | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationJobError';
  }
}

function validatedRetryAfterMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class AutomationJobRetryError extends Error {
  public readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: unknown = null) {
    super(message);
    this.name = 'AutomationJobRetryError';
    this.retryAfterMs = validatedRetryAfterMs(retryAfterMs);
  }
}

export function effectiveAutomationJobRetryDelayMs(
  localRetryDelayMs: number,
  providerRetryAfterMs?: number | null,
): number {
  positiveInteger(localRetryDelayMs, 'retryDelayMs');
  return Math.max(localRetryDelayMs, validatedRetryAfterMs(providerRetryAfterMs) ?? 0);
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new AutomationJobError('INVALID_INPUT', `${name} is required`);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AutomationJobError('INVALID_INPUT', `${name} must be a positive integer`);
}

function payloadEquals(left: Prisma.JsonValue, right: Prisma.InputJsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function createAutomationJob(input: CreateAutomationJobInput): Promise<AutomationJob & { replayed: boolean }> {
  requireText(input.userId, 'userId');
  requireText(input.type, 'type');
  requireText(input.correlationId, 'correlationId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  const priority = input.priority ?? 0;
  const payloadVersion = input.payloadVersion ?? 1;
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(priority)) throw new AutomationJobError('INVALID_INPUT', 'priority must be an integer');
  positiveInteger(payloadVersion, 'payloadVersion');
  positiveInteger(maxAttempts, 'maxAttempts');

  return withTenant(input.userId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
    if (input.automationRunId) {
      const run = await tx.automationRun.findFirst({ where: { id: input.automationRunId, userId: input.userId }, select: { id: true } });
      if (!run) throw new AutomationJobError('NOT_FOUND', 'Automation run not found for this user');
    }
    const existing = await tx.automationJob.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
    if (existing) {
      const matches = existing.userId === input.userId
        && existing.type === input.type
        && existing.applicationId === (input.applicationId ?? null)
        && existing.automationRunId === (input.automationRunId ?? null)
        && existing.priority === priority
        && existing.payloadVersion === payloadVersion
        && existing.maxAttempts === maxAttempts
        && existing.correlationId === input.correlationId
        && existing.requestedAvailableAt?.getTime() === input.availableAt?.getTime()
        && payloadEquals(existing.payload, input.payload);
      if (!matches) throw new AutomationJobError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different automation job');
      return { ...existing, replayed: true };
    }
    const job = await tx.automationJob.create({
      data: {
        userId: input.userId,
        applicationId: input.applicationId,
        automationRunId: input.automationRunId,
        type: input.type,
        status: JobStatus.AVAILABLE,
        priority,
        payload: input.payload,
        payloadVersion,
        maxAttempts,
        availableAt: input.availableAt,
        requestedAvailableAt: input.availableAt,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { ...job, replayed: false };
  });
}

export interface ValidateAutomationJobRetryInput {
  jobId: string;
  deliveryGeneration: number;
  expectedAttempt: number;
  nextDispatchAttempt: number;
}

export async function validateAutomationJobRetry(input: ValidateAutomationJobRetryInput): Promise<void> {
  requireText(input.jobId, 'jobId');
  positiveInteger(input.deliveryGeneration, 'deliveryGeneration');
  positiveInteger(input.expectedAttempt, 'expectedAttempt');
  positiveInteger(input.nextDispatchAttempt, 'nextDispatchAttempt');
  if (input.nextDispatchAttempt !== input.expectedAttempt + 1) {
    throw new AutomationJobError('INVALID_INPUT', 'nextDispatchAttempt must immediately follow expectedAttempt');
  }
  await prisma.$transaction(async (tx) => {
    const [job] = await tx.$queryRaw<Array<{
      status: JobStatus;
      deliveryGeneration: number;
      attemptCount: number;
      maxAttempts: number;
      cancelledAt: Date | null;
    }>>`
      SELECT status, "deliveryGeneration", "attemptCount", "maxAttempts", "cancelledAt"
      FROM automation_jobs
      WHERE id = ${input.jobId}
      FOR UPDATE
    `;
    if (!job) throw new AutomationJobError('NOT_FOUND', 'Automation job not found');
    if (
      job.status !== JobStatus.AVAILABLE
      || job.cancelledAt !== null
      || job.deliveryGeneration !== input.deliveryGeneration
      || job.attemptCount !== input.expectedAttempt
      || job.attemptCount >= job.maxAttempts
      || input.nextDispatchAttempt > job.maxAttempts
    ) {
      throw new AutomationJobError('LEASE_LOST', 'Automation job is not authorized for this queue retry');
    }
  });
}

export async function claimAutomationJobs(input: ClaimAutomationJobsInput): Promise<AutomationJob[]> {
  requireText(input.workerId, 'workerId');
  const limit = input.limit ?? 10;
  const leaseMs = input.leaseMs ?? 30_000;
  positiveInteger(limit, 'limit');
  positiveInteger(leaseMs, 'leaseMs');
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE automation_jobs
      SET status = 'DEAD_LETTER'::"JobStatus",
          "deliveryGeneration" = "deliveryGeneration" + 1,
          "completedAt" = ${now},
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = 'Lease expired after the final permitted attempt',
          "updatedAt" = ${now}
      WHERE status = 'LEASED'
        AND "leaseExpiresAt" <= ${now}
        AND "attemptCount" >= "maxAttempts"
    `;
    return tx.$queryRaw<AutomationJob[]>`
    WITH claimable AS (
      SELECT id
      FROM automation_jobs
      WHERE (
        (
          status IN ('PENDING', 'AVAILABLE')
          AND "availableAt" <= ${now}
        ) OR (
          status = 'LEASED'
          AND "leaseExpiresAt" <= ${now}
        )
      )
        AND "cancelledAt" IS NULL
        AND "attemptCount" < "maxAttempts"
      ORDER BY priority DESC, "availableAt", "createdAt", id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE automation_jobs AS job
    SET status = 'LEASED'::"JobStatus",
        "leaseOwner" = ${input.workerId},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "attemptCount" = job."attemptCount" + 1,
        "updatedAt" = ${now}
    FROM claimable
    WHERE job.id = claimable.id
    RETURNING job.*
  `;
  });
}

async function getOwnedJob(input: OwnedAutomationJobInput): Promise<AutomationJob> {
  const now = input.now ?? new Date();
  const job = await prisma.automationJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new AutomationJobError('NOT_FOUND', 'Automation job not found');
  if (job.status !== JobStatus.LEASED || job.leaseOwner !== input.workerId || !job.leaseExpiresAt || job.leaseExpiresAt <= now) {
    throw new AutomationJobError('LEASE_LOST', 'Automation job lease is absent, expired, or owned by another worker');
  }
  return job;
}

export async function leaseAutomationJob(input: LeaseAutomationJobInput): Promise<AutomationJob | null> {
  requireText(input.jobId, 'jobId');
  requireText(input.workerId, 'workerId');
  const leaseMs = input.leaseMs ?? 30_000;
  positiveInteger(leaseMs, 'leaseMs');
  if (input.expectedAttempt !== undefined) positiveInteger(input.expectedAttempt, 'expectedAttempt');
  if (input.deliveryGeneration !== undefined) positiveInteger(input.deliveryGeneration, 'deliveryGeneration');
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  return prisma.$transaction(async (tx) => {
    const leased = await tx.$queryRaw<AutomationJob[]>`
      UPDATE automation_jobs
      SET status = 'LEASED'::"JobStatus",
          "leaseOwner" = ${input.workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attemptCount" = "attemptCount" + 1,
          "updatedAt" = ${now}
      WHERE id = ${input.jobId}
        AND status IN ('PENDING', 'AVAILABLE')
        AND "availableAt" <= ${now}
        AND "cancelledAt" IS NULL
        AND "attemptCount" < "maxAttempts"
        AND (${input.expectedAttempt ?? null}::integer IS NULL OR "attemptCount" + 1 = ${input.expectedAttempt ?? null})
        AND (${input.deliveryGeneration ?? null}::integer IS NULL OR "deliveryGeneration" = ${input.deliveryGeneration ?? null})
        AND (
          "automationRunId" IS NULL
          OR EXISTS (
            SELECT 1 FROM automation_runs
            WHERE automation_runs.id = automation_jobs."automationRunId"
              AND automation_runs.status = 'RUNNING'
          )
        )
      RETURNING *
    `;
    return leased[0] ?? null;
  });
}

export async function renewAutomationJobLease(input: OwnedAutomationJobInput & { leaseMs?: number }): Promise<AutomationJob> {
  requireText(input.workerId, 'workerId');
  const leaseMs = input.leaseMs ?? 30_000;
  positiveInteger(leaseMs, 'leaseMs');
  const now = input.now ?? new Date();
  await getOwnedJob({ ...input, now });
  const updated = await prisma.automationJob.updateMany({
    where: { id: input.jobId, status: JobStatus.LEASED, leaseOwner: input.workerId, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
  });
  if (updated.count !== 1) throw new AutomationJobError('LEASE_LOST', 'Automation job lease changed concurrently');
  return prisma.automationJob.findUniqueOrThrow({ where: { id: input.jobId } });
}

export async function completeAutomationJob(input: OwnedAutomationJobInput): Promise<AutomationJob> {
  requireText(input.workerId, 'workerId');
  const now = input.now ?? new Date();
  await getOwnedJob({ ...input, now });
  const updated = await prisma.automationJob.updateMany({
    where: { id: input.jobId, status: JobStatus.LEASED, leaseOwner: input.workerId, leaseExpiresAt: { gt: now } },
    data: { status: JobStatus.SUCCEEDED, completedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null },
  });
  if (updated.count !== 1) throw new AutomationJobError('LEASE_LOST', 'Automation job lease changed concurrently');
  return prisma.automationJob.findUniqueOrThrow({ where: { id: input.jobId } });
}

export async function failAutomationJob(
  input: OwnedAutomationJobInput & { error: string; retryDelayMs?: number; providerRetryAfterMs?: number | null },
): Promise<AutomationJob> {
  requireText(input.workerId, 'workerId');
  requireText(input.error, 'error');
  const retryDelayMs = effectiveAutomationJobRetryDelayMs(input.retryDelayMs ?? 1_000, input.providerRetryAfterMs);
  const now = input.now ?? new Date();
  const job = await getOwnedJob({ ...input, now });
  const exhausted = job.attemptCount >= job.maxAttempts;
  const updated = await prisma.automationJob.updateMany({
    where: { id: input.jobId, status: JobStatus.LEASED, leaseOwner: input.workerId, leaseExpiresAt: { gt: now } },
    data: {
      status: exhausted ? JobStatus.DEAD_LETTER : JobStatus.AVAILABLE,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: input.error.slice(0, 10_000),
      ...(exhausted ? { completedAt: now } : { availableAt: new Date(now.getTime() + retryDelayMs) }),
    },
  });
  if (updated.count !== 1) throw new AutomationJobError('LEASE_LOST', 'Automation job lease changed concurrently');
  return prisma.automationJob.findUniqueOrThrow({ where: { id: input.jobId } });
}

export async function reconcileExpiredAutomationJobLeases(now = new Date()): Promise<{ available: number; deadLetter: number }> {
  return prisma.$transaction(async (tx) => {
    const deadLetter = await tx.$executeRaw`
      UPDATE automation_jobs
      SET status = 'DEAD_LETTER'::"JobStatus",
          "deliveryGeneration" = "deliveryGeneration" + 1,
          "completedAt" = ${now},
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = 'Lease expired after the final permitted attempt',
          "updatedAt" = ${now}
      WHERE status = 'LEASED'
        AND "leaseExpiresAt" <= ${now}
        AND "attemptCount" >= "maxAttempts"
    `;
    const available = await tx.$executeRaw`
      UPDATE automation_jobs
      SET status = 'AVAILABLE'::"JobStatus",
          "deliveryGeneration" = "deliveryGeneration" + 1,
          "availableAt" = ${now},
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "lastError" = 'Worker lease expired before completion',
          "updatedAt" = ${now}
      WHERE status = 'LEASED'
        AND "leaseExpiresAt" <= ${now}
        AND "attemptCount" < "maxAttempts"
    `;
    return { available, deadLetter };
  });
}

export async function replayDeadLetterAutomationJob(input: ReplayAutomationJobInput): Promise<AutomationJob> {
  requireText(input.jobId, 'jobId');
  requireText(input.userId, 'userId');
  requireText(input.reason, 'reason');
  requireText(input.correlationId, 'correlationId');
  const maxAttempts = input.maxAttempts ?? 3;
  positiveInteger(maxAttempts, 'maxAttempts');

  return withTenant(input.userId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`automation-job-replay:${input.jobId}`}, 0))`;
    const current = await tx.automationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!current) throw new AutomationJobError('NOT_FOUND', 'Automation job not found');
    if (current.status !== JobStatus.DEAD_LETTER) {
      throw new AutomationJobError('TERMINAL', 'Only dead-letter automation jobs can be replayed');
    }
    const existing = await tx.automationJob.findUnique({ where: { replayOfId: current.id } });
    if (existing) throw new AutomationJobError('TERMINAL', 'Automation job already has a replay');

    const replay = await tx.automationJob.create({
      data: {
        userId: current.userId,
        applicationId: current.applicationId,
        automationRunId: current.automationRunId,
        type: current.type,
        status: JobStatus.AVAILABLE,
        priority: current.priority,
        payload: current.payload as Prisma.InputJsonValue,
        payloadVersion: current.payloadVersion,
        maxAttempts,
        correlationId: input.correlationId,
        idempotencyKey: `replay:${current.id}:${input.correlationId}`,
        replayOfId: current.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'AUTOMATION_JOB_REPLAYED',
        resource: 'AutomationJob',
        resourceId: replay.id,
        details: {
          replayOfId: current.id,
          reason: input.reason.slice(0, 2_000),
          correlationId: input.correlationId,
          payloadVersion: current.payloadVersion,
        },
      },
    });
    return replay;
  });
}

export async function cancelAutomationJob(jobId: string, userId: string, now = new Date()): Promise<AutomationJob> {
  requireText(jobId, 'jobId');
  requireText(userId, 'userId');
  return withTenant(userId, async (tx) => {
    const current = await tx.automationJob.findFirst({ where: { id: jobId, userId } });
    if (!current) throw new AutomationJobError('NOT_FOUND', 'Automation job not found');
    if (current.status === JobStatus.SUCCEEDED || current.status === JobStatus.FAILED || current.status === JobStatus.CANCELLED || current.status === JobStatus.DEAD_LETTER) {
      if (current.status === JobStatus.CANCELLED) return current;
      throw new AutomationJobError('TERMINAL', `Cannot cancel a ${current.status} automation job`);
    }
    const changed = await tx.automationJob.updateMany({
      where: { id: jobId, userId, status: current.status, updatedAt: current.updatedAt },
      data: { status: JobStatus.CANCELLED, cancelledAt: now, completedAt: now, leaseOwner: null, leaseExpiresAt: null },
    });
    if (changed.count !== 1) throw new AutomationJobError('TERMINAL', 'Automation job changed concurrently and was not cancelled');

    if (current.type === 'DISCOVER_JOBS') {
      const discoveryRun = await tx.jobDiscoveryRun.findFirst({
        where: { id: current.correlationId, userId },
        select: { id: true, status: true, errorRetryable: true, startedAt: true, updatedAt: true },
      });
      const cancellable = discoveryRun && (
        discoveryRun.status === 'PENDING'
        || discoveryRun.status === 'RUNNING'
        || ((discoveryRun.status === 'FAILED' || discoveryRun.status === 'PARTIAL') && discoveryRun.errorRetryable === true)
      );
      if (cancellable) {
        await tx.jobDiscoveryRun.updateMany({
          where: {
            id: discoveryRun.id,
            userId,
            status: discoveryRun.status,
            updatedAt: discoveryRun.updatedAt,
          },
          data: {
            status: 'CANCELLED',
            startedAt: discoveryRun.startedAt ?? now,
            heartbeatAt: now,
            completedAt: now,
            errorCount: { increment: 1 },
            errorClass: 'CANCELLED',
            errorCode: 'DISCOVERY_CANCELLED',
            errorMessage: 'Discovery run was cancelled by the user',
            errorRetryable: false,
          },
        });
      }
    }

    return tx.automationJob.findUniqueOrThrow({ where: { id: jobId } });
  });
}
