import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { JobStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { AutomationQueueRegistry, queueJobId, redisConnection } from '@jobagent/queue';
import { dispatchAutomationJobs } from './automation-job-dispatcher';
import { createAutomationJob, reconcileExpiredAutomationJobLeases } from './automation-jobs';
import { startAutomationWorker } from './automation-worker';

const enabled = process.env.QUEUE_STALL_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeStall = enabled ? describe : describe.skip;
const prefix = `queue-stall-${randomUUID()}`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForDatabaseJob(jobId: string, predicate: (job: {
  status: JobStatus;
  leaseExpiresAt: Date | null;
}) => boolean, timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const job = await prisma.automationJob.findUnique({
      where: { id: jobId },
      select: { status: true, leaseExpiresAt: true },
    });
    if (job && predicate(job)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PostgreSQL job ${jobId}`);
}

function waitForStalled(queueEvents: QueueEvents, jobId: string, timeout = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queueEvents.off('stalled', onStalled);
      reject(new Error(`Timed out waiting for BullMQ job ${jobId} to stall`));
    }, timeout);
    const onStalled = ({ jobId: stalledJobId }: { jobId: string }) => {
      if (stalledJobId !== jobId) return;
      clearTimeout(timer);
      queueEvents.off('stalled', onStalled);
      resolve();
    };
    queueEvents.on('stalled', onStalled);
  });
}

describeStall.sequential('BullMQ lock-loss recovery', () => {
  const userId = randomUUID();
  const registry = new AutomationQueueRegistry({ prefix });
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.invalid`,
        passwordHash: 'fixture',
        name: 'Queue Stall Fixture',
      },
    });
  });

  afterAll(async () => {
    await registry.drain('applications');
    await registry.close();
    await prisma.automationJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('rejects stale completion after real BullMQ lock loss and records one recovered success', async () => {
    const created = await createAutomationJob({
      userId,
      // A real `applications`-routed type: this test supplies its own worker handler, and
      // job routing is exact-match, so an invented type would be quarantined on
      // `maintenance` and the worker under test would never see the job.
      type: 'VERIFY_SUBMISSION_CONFIRMATION',
      payload: { target: 'https://jobs.example.invalid/stalled-fixture' },
      correlationId: randomUUID(),
      idempotencyKey: `queue-stall:${randomUUID()}`,
      maxAttempts: 3,
    });
    createdJobIds.push(created.id);
    await dispatchAutomationJobs(registry, { userId });

    const queue = registry.queue('applications');
    const bullJobId = queueJobId(created.id, 1);
    const queueEvents = new QueueEvents('applications', { connection: redisConnection(), prefix });
    await queueEvents.waitUntilReady();
    const stalled = waitForStalled(queueEvents, bullJobId);
    const staleStarted = deferred();
    const releaseStale = deferred();
    let staleExecutions = 0;
    let recoveryExecutions = 0;
    const staleWorker = startAutomationWorker({
      name: 'applications',
      workerId: 'queue-stall-stale',
      prefix,
      concurrency: 1,
      leaseMs: 400,
      lockDurationMs: 200,
      stalledIntervalMs: 100,
      maxStalledCount: 2,
      handler: async ({ automationJobId }) => {
        if (automationJobId !== created.id) return;
        staleExecutions += 1;
        staleStarted.resolve();
        await releaseStale.promise;
      },
    });

    let recoveryWorker: ReturnType<typeof startAutomationWorker> | undefined;
    try {
      await staleStarted.promise;
      await expect(queue.getJobState(bullJobId)).resolves.toBe('active');
      const backend = queue.getBackend();
      const redis = await backend.connection.client;
      await redis.del(`${queue.toKey(bullJobId)}:lock`);
      await stalled;

      await waitForDatabaseJob(created.id, (job) => (
        job.status === JobStatus.LEASED
        && job.leaseExpiresAt !== null
        && job.leaseExpiresAt.getTime() <= Date.now()
      ));
      await expect(reconcileExpiredAutomationJobLeases()).resolves.toEqual({ available: 1, deadLetter: 0 });
      await expect(dispatchAutomationJobs(registry, { userId })).resolves.toMatchObject({ dispatched: 1, failed: 0 });

      recoveryWorker = startAutomationWorker({
        name: 'applications',
        workerId: 'queue-stall-recovery',
        prefix,
        concurrency: 1,
        handler: async ({ automationJobId }) => {
          if (automationJobId === created.id) recoveryExecutions += 1;
        },
      });
      await waitForDatabaseJob(created.id, (job) => job.status === JobStatus.SUCCEEDED);
      releaseStale.resolve();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(staleExecutions).toBe(1);
      expect(recoveryExecutions).toBe(1);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
        status: JobStatus.SUCCEEDED,
        attemptCount: 2,
        deliveryGeneration: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } finally {
      releaseStale.resolve();
      await Promise.allSettled([
        staleWorker.close(true),
        recoveryWorker?.close(true) ?? Promise.resolve(),
        queueEvents.close(),
      ]);
    }
  }, 30_000);
});
