import { randomUUID } from 'node:crypto';
import { JobStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import {
  cancelAutomationJob,
  claimAutomationJobs,
  completeAutomationJob,
  createAutomationJob,
  failAutomationJob,
  leaseAutomationJob,
  reconcileExpiredAutomationJobLeases,
  renewAutomationJobLease,
  replayDeadLetterAutomationJob,
  validateAutomationJobRetry,
} from './automation-jobs';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function jobInput(userId: string, overrides: Partial<Parameters<typeof createAutomationJob>[0]> = {}) {
  const token = randomUUID();
  return {
    userId,
    type: 'GOAL4_FIXTURE',
    payload: { token },
    correlationId: randomUUID(),
    idempotencyKey: `goal4:${token}`,
    ...overrides,
  };
}

describeDatabase.sequential('AutomationJob execution model', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const otherRunId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 4 Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 4 Other Fixture' },
    ] });
    await prisma.automationRun.create({ data: { id: otherRunId, userId: otherUserId } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('creates versioned jobs and replays matching idempotency keys', async () => {
    const input = jobInput(userId, { payloadVersion: 2, maxAttempts: 4, priority: 8 });
    await expect(createAutomationJob(input)).resolves.toMatchObject({ replayed: false, status: JobStatus.AVAILABLE, payloadVersion: 2, maxAttempts: 4, priority: 8 });
    await expect(createAutomationJob(input)).resolves.toMatchObject({ replayed: true });
    await expect(createAutomationJob({ ...input, payload: { changed: true } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(createAutomationJob({ ...input, priority: 99 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('replays semantically identical JSON payloads regardless of object key order', async () => {
    const input = jobInput(userId, { payload: { alpha: { first: 1, second: 2 }, beta: true } });
    const created = await createAutomationJob(input);
    await expect(createAutomationJob({
      ...input,
      payload: { beta: true, alpha: { second: 2, first: 1 } },
    })).resolves.toMatchObject({ id: created.id, replayed: true });
  });

  it('serializes concurrent creation by idempotency key', async () => {
    const input = jobInput(userId, { priority: 9 });
    const results = await Promise.all([createAutomationJob(input), createAutomationJob(input)]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id))).toHaveLength(1);
  });

  it('preserves scheduling identity independently from mutable availability', async () => {
    const scheduled = new Date(Date.now() + 60_000);
    const input = jobInput(userId, { availableAt: scheduled });
    const created = await createAutomationJob(input);
    await prisma.automationJob.update({ where: { id: created.id }, data: { availableAt: new Date(scheduled.getTime() + 5_000) } });
    await expect(createAutomationJob(input)).resolves.toMatchObject({ id: created.id, replayed: true });
    await expect(createAutomationJob({ ...input, availableAt: undefined })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const immediate = jobInput(userId);
    await createAutomationJob(immediate);
    await expect(createAutomationJob({ ...immediate, availableAt: scheduled })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('scopes keys by tenant and rejects cross-tenant automation runs', async () => {
    const idempotencyKey = randomUUID();
    const shared = { type: 'GOAL4_TENANT_KEY', payload: { shared: true }, correlationId: randomUUID(), idempotencyKey };
    const [first, second] = await Promise.all([
      createAutomationJob({ ...shared, userId }),
      createAutomationJob({ ...shared, userId: otherUserId }),
    ]);
    expect(first.id).not.toBe(second.id);
    await expect(createAutomationJob(jobInput(userId, { automationRunId: otherRunId }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('claims by priority once across concurrent workers', async () => {
    const low = await createAutomationJob(jobInput(userId, { priority: 1, type: 'GOAL4_CONCURRENT_CLAIM' }));
    const high = await createAutomationJob(jobInput(userId, { priority: 20, type: 'GOAL4_CONCURRENT_CLAIM' }));
    const middle = await createAutomationJob(jobInput(userId, { priority: 10, type: 'GOAL4_CONCURRENT_CLAIM' }));
    const unrelated = await prisma.automationJob.findMany({ where: { userId, type: { not: 'GOAL4_CONCURRENT_CLAIM' }, status: JobStatus.AVAILABLE } });
    await prisma.automationJob.updateMany({ where: { id: { in: unrelated.map((job) => job.id) } }, data: { availableAt: new Date(Date.now() + 60_000) } });
    const results = await Promise.all([
      claimAutomationJobs({ workerId: 'goal4-a', limit: 2 }),
      claimAutomationJobs({ workerId: 'goal4-b', limit: 2 }),
    ]);
    const claimed = results.flat().filter((job) => [low.id, middle.id, high.id].includes(job.id));
    expect(new Set(claimed.map((job) => job.id))).toHaveLength(3);
    expect(claimed.every((job) => job.status === JobStatus.LEASED && job.attemptCount === 1)).toBe(true);
    const priorityOrder = [...claimed].sort((a, b) => b.priority - a.priority).map((job) => job.id);
    expect(priorityOrder).toEqual([high.id, middle.id, low.id]);
  });

  it('renews and completes only with a live matching lease', async () => {
    const created = await createAutomationJob(jobInput(userId, { priority: 100 }));
    const [claimed] = await claimAutomationJobs({ workerId: 'goal4-owner', limit: 1, leaseMs: 5_000 });
    expect(claimed.id).toBe(created.id);
    const originalExpiry = claimed.leaseExpiresAt!;
    await expect(renewAutomationJobLease({ jobId: created.id, workerId: 'goal4-other' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const renewed = await renewAutomationJobLease({ jobId: created.id, workerId: 'goal4-owner', leaseMs: 10_000 });
    expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(originalExpiry.getTime());
    await expect(completeAutomationJob({ jobId: created.id, workerId: 'goal4-owner' })).resolves.toMatchObject({ status: JobStatus.SUCCEEDED, completedAt: expect.any(Date), leaseOwner: null });
    await expect(completeAutomationJob({ jobId: created.id, workerId: 'goal4-owner' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('reclaims expired leases and dead-letters exhausted jobs', async () => {
    const first = await createAutomationJob(jobInput(userId, { priority: 200, maxAttempts: 2 }));
    const start = new Date(Date.now() + 100);
    await expect(leaseAutomationJob({ jobId: first.id, workerId: 'goal4-crashed', leaseMs: 1_000, now: start }))
      .resolves.toMatchObject({ id: first.id, leaseOwner: 'goal4-crashed', attemptCount: 1 });
    const [reclaimed] = await claimAutomationJobs({ workerId: 'goal4-recovery', limit: 1, leaseMs: 10_000, now: new Date(start.getTime() + 1_001) });
    expect(reclaimed).toMatchObject({ id: first.id, leaseOwner: 'goal4-recovery', attemptCount: 2 });
    await expect(failAutomationJob({ jobId: first.id, workerId: 'goal4-recovery', error: 'second failure', now: new Date(start.getTime() + 1_002) }))
      .resolves.toMatchObject({ status: JobStatus.DEAD_LETTER, completedAt: expect.any(Date), lastError: 'second failure' });
  });

  it('dead-letters a final-attempt lease that expires without worker reporting', async () => {
    const created = await createAutomationJob(jobInput(userId, { priority: 250, maxAttempts: 1 }));
    const start = new Date();
    const [claimed] = await claimAutomationJobs({ workerId: 'goal4-final-crash', limit: 1, leaseMs: 1_000, now: start });
    expect(claimed.id).toBe(created.id);
    await claimAutomationJobs({ workerId: 'goal4-reaper', limit: 1, now: new Date(start.getTime() + 1_001) });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
      status: JobStatus.DEAD_LETTER,
      completedAt: expect.any(Date),
      leaseOwner: null,
      lastError: 'Lease expired after the final permitted attempt',
    });
  });

  it('reconciles expired worker leases before redispatch', async () => {
    const retryable = await createAutomationJob(jobInput(userId, { priority: 260, maxAttempts: 2 }));
    const exhausted = await createAutomationJob(jobInput(userId, { priority: 261, maxAttempts: 1 }));
    const start = new Date();
    await expect(leaseAutomationJob({ jobId: retryable.id, workerId: 'goal4-reconcile-retry', leaseMs: 1_000, now: start }))
      .resolves.toMatchObject({ status: JobStatus.LEASED, attemptCount: 1 });
    await expect(leaseAutomationJob({ jobId: exhausted.id, workerId: 'goal4-reconcile-final', leaseMs: 1_000, now: start }))
      .resolves.toMatchObject({ status: JobStatus.LEASED, attemptCount: 1 });

    const now = new Date(start.getTime() + 1_001);
    await expect(reconcileExpiredAutomationJobLeases(now)).resolves.toEqual({ available: 1, deadLetter: 1 });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: retryable.id } })).resolves.toMatchObject({
      status: JobStatus.AVAILABLE,
      availableAt: now,
      attemptCount: 1,
      leaseOwner: null,
      lastError: 'Worker lease expired before completion',
    });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: exhausted.id } })).resolves.toMatchObject({
      status: JobStatus.DEAD_LETTER,
      completedAt: now,
      leaseOwner: null,
      lastError: 'Lease expired after the final permitted attempt',
    });
  });

  it('creates one audited replay with a new immutable identity', async () => {
    const original = await createAutomationJob(jobInput(userId, { priority: 275, maxAttempts: 1 }));
    const start = new Date();
    await leaseAutomationJob({ jobId: original.id, workerId: 'goal5-replay-failure', leaseMs: 10_000, now: start });
    await failAutomationJob({ jobId: original.id, workerId: 'goal5-replay-failure', error: 'provider unavailable', now: new Date(start.getTime() + 1) });
    const correlationId = randomUUID();
    const replay = await replayDeadLetterAutomationJob({
      jobId: original.id,
      userId,
      reason: 'Operator confirmed the provider outage is resolved',
      correlationId,
      maxAttempts: 2,
    });

    expect(replay.id).not.toBe(original.id);
    expect(replay).toMatchObject({
      replayOfId: original.id,
      status: JobStatus.AVAILABLE,
      attemptCount: 0,
      maxAttempts: 2,
      payload: original.payload,
      payloadVersion: original.payloadVersion,
      correlationId,
    });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: original.id } }))
      .resolves.toMatchObject({ status: JobStatus.DEAD_LETTER, completedAt: expect.any(Date) });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { resourceId: replay.id, action: 'AUTOMATION_JOB_REPLAYED' } }))
      .resolves.toMatchObject({ userId, details: expect.objectContaining({ replayOfId: original.id, correlationId }) });
    await expect(replayDeadLetterAutomationJob({
      jobId: original.id,
      userId,
      reason: 'Duplicate replay',
      correlationId: randomUUID(),
    })).rejects.toMatchObject({ code: 'TERMINAL' });
  });

  it('rejects replay for non-dead-letter and cross-tenant jobs', async () => {
    const available = await createAutomationJob(jobInput(userId));
    const input = { jobId: available.id, userId, reason: 'Invalid replay', correlationId: randomUUID() };
    await expect(replayDeadLetterAutomationJob(input)).rejects.toMatchObject({ code: 'TERMINAL' });
    await expect(replayDeadLetterAutomationJob({ ...input, userId: otherUserId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requeues retryable failures at the authoritative greater retry delay', async () => {
    const created = await createAutomationJob(jobInput(userId, { priority: 300, maxAttempts: 3 }));
    const start = new Date();
    const [claimed] = await claimAutomationJobs({ workerId: 'goal4-retry', limit: 1, leaseMs: 10_000, now: start });
    expect(claimed.id).toBe(created.id);
    const retryAt = new Date(start.getTime() + 15_000);
    await expect(failAutomationJob({
      jobId: created.id,
      workerId: 'goal4-retry',
      error: 'temporary',
      retryDelayMs: 5_000,
      providerRetryAfterMs: 15_000,
      now: start,
    })).resolves.toMatchObject({ status: JobStatus.AVAILABLE, availableAt: retryAt, attemptCount: 1 });
    await expect(claimAutomationJobs({ workerId: 'goal4-too-early', limit: 1, now: new Date(retryAt.getTime() - 1) }))
      .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));
    await expect(claimAutomationJobs({ workerId: 'goal4-after-delay', limit: 1, now: retryAt }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, attemptCount: 2 })]));
  });

  it('atomically denies retry advancement after cancellation or stale delivery', async () => {
    const cancelled = await createAutomationJob(jobInput(userId, { priority: 350, maxAttempts: 3 }));
    const firstLease = await leaseAutomationJob({
      jobId: cancelled.id,
      workerId: 'goal4-retry-cancelled',
      expectedAttempt: 1,
      deliveryGeneration: cancelled.deliveryGeneration,
    });
    expect(firstLease).toMatchObject({ attemptCount: 1 });
    await failAutomationJob({
      jobId: cancelled.id,
      workerId: 'goal4-retry-cancelled',
      error: 'temporary',
    });

    let authorization!: Promise<void>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM automation_jobs WHERE id = ${cancelled.id} FOR UPDATE`;
      authorization = validateAutomationJobRetry({
        jobId: cancelled.id,
        deliveryGeneration: cancelled.deliveryGeneration,
        expectedAttempt: 1,
        nextDispatchAttempt: 2,
      });
      const now = new Date();
      await tx.automationJob.update({
        where: { id: cancelled.id },
        data: { status: JobStatus.CANCELLED, cancelledAt: now, completedAt: now },
      });
    });
    await expect(authorization).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: cancelled.id } }))
      .resolves.toMatchObject({ status: JobStatus.CANCELLED, attemptCount: 1 });

    const stale = await createAutomationJob(jobInput(userId, { priority: 351, maxAttempts: 3 }));
    await leaseAutomationJob({
      jobId: stale.id,
      workerId: 'goal4-retry-stale',
      expectedAttempt: 1,
      deliveryGeneration: stale.deliveryGeneration,
    });
    await failAutomationJob({ jobId: stale.id, workerId: 'goal4-retry-stale', error: 'temporary' });
    await expect(validateAutomationJobRetry({
      jobId: stale.id,
      deliveryGeneration: stale.deliveryGeneration + 1,
      expectedAttempt: 1,
      nextDispatchAttempt: 2,
    })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: stale.id } }))
      .resolves.toMatchObject({ attemptCount: 1 });
  });

  it('enforces terminal and lease invariants in PostgreSQL', async () => {
    const created = await createAutomationJob(jobInput(userId));
    await expect(prisma.automationJob.update({
      where: { id: created.id },
      data: { status: JobStatus.SUCCEEDED },
    })).rejects.toThrow();
    await expect(prisma.automationJob.update({
      where: { id: created.id },
      data: { status: JobStatus.LEASED, leaseOwner: 'broken' },
    })).rejects.toThrow();
  });

  it('cancels queued and leased jobs and prevents later claims', async () => {
    const queued = await createAutomationJob(jobInput(userId, { priority: 400 }));
    await expect(cancelAutomationJob(queued.id, userId)).resolves.toMatchObject({ status: JobStatus.CANCELLED, cancelledAt: expect.any(Date), completedAt: expect.any(Date) });
    await expect(cancelAutomationJob(queued.id, userId)).resolves.toMatchObject({ status: JobStatus.CANCELLED });

    const leased = await createAutomationJob(jobInput(userId, { priority: 500 }));
    const [claimed] = await claimAutomationJobs({ workerId: 'goal4-cancelled-owner', limit: 1 });
    expect(claimed.id).toBe(leased.id);
    await expect(cancelAutomationJob(leased.id, userId)).resolves.toMatchObject({ status: JobStatus.CANCELLED, leaseOwner: null });
    await expect(completeAutomationJob({ jobId: leased.id, workerId: 'goal4-cancelled-owner' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('does not let cancellation overwrite concurrent successful completion', async () => {
    const created = await createAutomationJob(jobInput(userId, { priority: 600 }));
    const [claimed] = await claimAutomationJobs({ workerId: 'goal4-terminal-race', limit: 1, leaseMs: 10_000 });
    expect(claimed.id).toBe(created.id);
    const results = await Promise.allSettled([
      completeAutomationJob({ jobId: created.id, workerId: 'goal4-terminal-race' }),
      cancelAutomationJob(created.id, userId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } });
    expect([JobStatus.SUCCEEDED, JobStatus.CANCELLED]).toContain(stored.status);
    expect(stored.completedAt).toBeInstanceOf(Date);
  });
});
