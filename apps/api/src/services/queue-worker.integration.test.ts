import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { JobStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import {
  AutomationQueueRegistry,
  collectQueueMetrics,
  deadLetterQueueName,
  QUEUE_NAMES,
  queueJobId,
  redisConnection,
} from '@jobagent/queue';
import { dispatchAutomationJobs } from './automation-job-dispatcher';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import {
  cancelAutomationJob,
  createAutomationJob,
  leaseAutomationJob,
  reconcileExpiredAutomationJobLeases,
} from './automation-jobs';
import { createDiscoveryRuns, executeDiscoveryRun } from './job-discovery';
import { startAutomationWorker } from './automation-worker';

const enabled = process.env.QUEUE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeQueue = enabled ? describe : describe.skip;
const connection = redisConnection();
const prefix = `goal5-${randomUUID()}`;

function jobInput(userId: string, overrides: Partial<Parameters<typeof createAutomationJob>[0]> = {}) {
  const token = randomUUID();
  return {
    userId,
    // This fixture supplies its own worker handler, so the type only has to route to the
    // `applications` queue. It is a real routed type rather than an invented one: job
    // routing is an exact-match table, so a made-up type would be quarantined on
    // `maintenance` and never reach the queue under test.
    type: 'VERIFY_SUBMISSION_CONFIRMATION',
    payload: { token },
    correlationId: randomUUID(),
    idempotencyKey: `goal5:${token}`,
    ...overrides,
  };
}

async function waitForState(queue: Queue, jobId: string, state: string, timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const job = await queue.getJob(jobId);
    if (state === 'removed' && !job) return;
    if (job && await job.getState() === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to become ${state}`);
}

async function waitForDatabaseJob(jobId: string, statuses: readonly JobStatus[], timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const job = await prisma.automationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job && statuses.includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to reach ${statuses.join(' or ')}`);
}

describeQueue.sequential('BullMQ worker infrastructure', () => {
  const userId = randomUUID();
  const registry = new AutomationQueueRegistry({ prefix });
  const createdJobIds: string[] = [];

  async function createFixture(overrides: Partial<Parameters<typeof createAutomationJob>[0]> = {}) {
    const job = await createAutomationJob(jobInput(userId, overrides));
    createdJobIds.push(job.id);
    return job;
  }

  function forgetFixture(jobId: string): void {
    const index = createdJobIds.indexOf(jobId);
    if (index >= 0) createdJobIds.splice(index, 1);
  }

  async function clearQueues(): Promise<void> {
    await Promise.all(QUEUE_NAMES.flatMap((name) => {
      const queue = new Queue(name, { connection, prefix });
      const dead = new Queue(deadLetterQueueName(name), { connection, prefix });
      return [
        queue.obliterate({ force: true }).finally(() => queue.close()),
        dead.obliterate({ force: true }).finally(() => dead.close()),
      ];
    }));
  }

  beforeAll(async () => {
    await prisma.automationJob.deleteMany({ where: { status: { in: [JobStatus.PENDING, JobStatus.AVAILABLE] } } });
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 5 Fixture' } });
  });

  afterEach(async () => {
    await clearQueues();
    await prisma.automationJob.deleteMany({ where: { userId } });
    createdJobIds.length = 0;
  });

  afterAll(async () => {
    await clearQueues();
    await registry.close();
    await prisma.automationJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.jobDiscoveryRun.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('runs a discovery job through the live dispatcher and production worker', async () => {
    const [run] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-queue-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const automationJob = await prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'DISCOVER_JOBS', correlationId: run.id },
    });
    createdJobIds.push(automationJob.id);
    expect(automationJob.status).toBe(JobStatus.AVAILABLE);

    await expect(dispatchAutomationJobs(registry, { userId })).resolves.toMatchObject({ dispatched: 1, failed: 0 });
    await expect(registry.queue('discovery').getJob(queueJobId(automationJob.id, 1))).resolves.toBeTruthy();

    let executions = 0;
    const runDiscovery: typeof executeDiscoveryRun = (claimedUserId, runId, _executor, signal) => {
      executions += 1;
      return executeDiscoveryRun(claimedUserId, runId, { discover: async () => ({
        jobs: [], page: { pageSize: 100, returned: 0, hasMore: false },
      }) }, signal);
    };
    const handler = createProductionAutomationJobHandlers({ executeDiscoveryRun: runDiscovery }).get('DISCOVER_JOBS')!;
    const worker = startAutomationWorker({
      name: 'discovery', workerId: 'goal7-discovery', prefix, concurrency: 1, handler,
    });
    try {
      await waitForDatabaseJob(automationJob.id, [JobStatus.SUCCEEDED]);
      expect(executions).toBe(1);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: automationJob.id } }))
        .resolves.toMatchObject({
          status: JobStatus.SUCCEEDED, attemptCount: 1, leaseOwner: null, leaseExpiresAt: null,
        });
      await expect(prisma.jobDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } }))
        .resolves.toMatchObject({ status: 'SUCCEEDED', completedAt: expect.any(Date) });
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('dispatches durable jobs idempotently to named queues and reports metrics', async () => {
    const created = await createFixture();
    await expect(dispatchAutomationJobs(registry, { userId })).resolves.toMatchObject({ dispatched: expect.any(Number), failed: 0 });
    await dispatchAutomationJobs(registry, { userId });
    const queue = registry.queue('applications');
    await expect(queue.getJob(queueJobId(created.id, 1))).resolves.toBeTruthy();
    const metrics = await collectQueueMetrics(registry, ['applications']);
    expect(metrics[0]!.waiting + metrics[0]!.active + metrics[0]!.delayed + metrics[0]!.prioritized
      + metrics[0]!.completed + metrics[0]!.failed).toBeGreaterThanOrEqual(1);
    await registry.remove(created.id, created.type);
    await prisma.automationJob.delete({ where: { id: created.id } });
    forgetFixture(created.id);
  });

  it('keeps PostgreSQL authoritative through successful worker completion', async () => {
    const created = await createFixture({ priority: 100 });
    await dispatchAutomationJobs(registry, { userId });
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-success',
      prefix,
      concurrency: 1,
      handler: async ({ payload }) => { expect(payload).toEqual(created.payload); },
    });
    try {
      await waitForDatabaseJob(created.id, [JobStatus.SUCCEEDED]);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ status: JobStatus.SUCCEEDED, attemptCount: 1, leaseOwner: null });
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('survives duplicate dispatch and executes one authoritative attempt', async () => {
    const created = await createFixture({ priority: 120 });
    await Promise.all([
      dispatchAutomationJobs(registry, { userId }),
      dispatchAutomationJobs(registry, { userId }),
    ]);
    const queue = registry.queue('applications');
    const jobs = await queue.getJobs(['wait', 'prioritized', 'delayed']);
    expect(jobs.filter((job) => job.data.automationJobId === created.id)).toHaveLength(1);
    let executions = 0;
    const workers = ['goal5-duplicate-a', 'goal5-duplicate-b'].map((workerId) => startAutomationWorker({
      name: 'applications',
      workerId,
      prefix,
      concurrency: 1,
      handler: async ({ automationJobId }) => {
        if (automationJobId === created.id) executions += 1;
      },
    }));
    try {
      await waitForDatabaseJob(created.id, [JobStatus.SUCCEEDED]);
      expect(executions).toBe(1);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ attemptCount: 1, status: JobStatus.SUCCEEDED });
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  }, 20_000);

  it('redispatches an expired lease as a new delivery with the remaining attempt budget', async () => {
    const created = await createFixture({ priority: 150, maxAttempts: 3 });
    const start = new Date(Date.now() + 100);
    await expect(leaseAutomationJob({ jobId: created.id, workerId: 'goal5-crashed', leaseMs: 1_000, now: start }))
      .resolves.toMatchObject({ status: JobStatus.LEASED, attemptCount: 1 });
    await reconcileExpiredAutomationJobLeases(new Date(start.getTime() + 1_001));
    await expect(dispatchAutomationJobs(registry, { userId, now: new Date(start.getTime() + 1_002) }))
      .resolves.toMatchObject({ dispatched: 1, failed: 0 });
    const queue = registry.queue('applications');
    const recovered = await queue.getJob(queueJobId(created.id, 2));
    expect(recovered).toBeTruthy();
    expect(recovered!.data.deliveryGeneration).toBe(2);
    expect(recovered!.opts.attempts).toBe(2);
    await registry.remove(created.id, created.type, 2);
  });

  it('reconciles a completed stale delivery into a new authoritative attempt', async () => {
    const created = await createFixture({ priority: 155, maxAttempts: 3 });
    await dispatchAutomationJobs(registry, { userId });
    const start = new Date();
    await expect(leaseAutomationJob({ jobId: created.id, workerId: 'goal5-process-crash', leaseMs: 1_000, now: start }))
      .resolves.toMatchObject({ status: JobStatus.LEASED, attemptCount: 1 });
    const staleWorker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-stale-delivery',
      prefix,
      concurrency: 1,
      handler: async () => { throw new Error('stale delivery must not execute'); },
    });
    try {
      await waitForState(registry.queue('applications'), queueJobId(created.id, 1), 'removed');
    } finally {
      await staleWorker.close();
    }
    await reconcileExpiredAutomationJobLeases(new Date(start.getTime() + 1_001));
    await dispatchAutomationJobs(registry, { userId, now: new Date(start.getTime() + 1_002) });
    const recovered = await registry.queue('applications').getJob(queueJobId(created.id, 2));
    expect(recovered).toBeTruthy();
    expect(recovered!.data.deliveryGeneration).toBe(2);
    expect(recovered!.opts.attempts).toBe(2);
    await registry.remove(created.id, created.type, 2);
  }, 20_000);

  it('executes higher-priority deliveries first', async () => {
    await registry.pause('applications');
    const low = await createFixture({ priority: 10 });
    const high = await createFixture({ priority: 1_000 });
    await dispatchAutomationJobs(registry, { userId });
    const order: string[] = [];
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-priority',
      prefix,
      concurrency: 1,
      handler: async ({ automationJobId }) => { order.push(automationJobId); },
    });
    try {
      await registry.resume('applications');
      await Promise.all([
        waitForDatabaseJob(low.id, [JobStatus.SUCCEEDED]),
        waitForDatabaseJob(high.id, [JobStatus.SUCCEEDED]),
      ]);
      expect(order).toEqual([high.id, low.id]);
    } finally {
      await registry.resume('applications');
      await worker.close();
    }
  }, 20_000);

  it('does not execute a future delivery before its schedule', async () => {
    const availableAt = new Date(Date.now() + 500);
    const created = await createFixture({ priority: 170, availableAt });
    await dispatchAutomationJobs(registry, { userId, now: availableAt });
    let startedAt = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-delay',
      prefix,
      concurrency: 1,
      handler: async () => { startedAt = Date.now(); },
    });
    try {
      await waitForDatabaseJob(created.id, [JobStatus.SUCCEEDED]);
      expect(startedAt).toBeGreaterThanOrEqual(availableAt.getTime());
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('enforces configured concurrency', async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, (_, index) => createFixture({ priority: 300 + index })));
    await dispatchAutomationJobs(registry, { userId });
    let active = 0;
    let maximumActive = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-concurrency',
      prefix,
      concurrency: 2,
      handler: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active -= 1;
      },
    });
    try {
      await Promise.all(jobs.map((job) => waitForDatabaseJob(job.id, [JobStatus.SUCCEEDED])));
      expect(maximumActive).toBe(2);
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('enforces the configured worker rate limit', async () => {
    const jobs = await Promise.all(Array.from({ length: 3 }, (_, index) => createFixture({ priority: 400 + index })));
    await dispatchAutomationJobs(registry, { userId });
    const starts: number[] = [];
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-rate-limit',
      prefix,
      concurrency: 3,
      limiter: { max: 1, duration: 200 },
      handler: async () => { starts.push(Date.now()); },
    });
    try {
      await Promise.all(jobs.map((job) => waitForDatabaseJob(job.id, [JobStatus.SUCCEEDED])));
      starts.sort((left, right) => left - right);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(125);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(125);
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('honors queue pause and resume without changing PostgreSQL authority', async () => {
    const created = await createFixture({ priority: 175 });
    await registry.pause('applications');
    await dispatchAutomationJobs(registry, { userId });
    let executions = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-pause',
      prefix,
      concurrency: 1,
      handler: async () => { executions += 1; },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(executions).toBe(0);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ status: JobStatus.AVAILABLE, attemptCount: 0 });
      await registry.resume('applications');
      await waitForDatabaseJob(created.id, [JobStatus.SUCCEEDED]);
      expect(executions).toBe(1);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ status: JobStatus.SUCCEEDED, attemptCount: 1 });
    } finally {
      await registry.resume('applications');
      await worker.close();
    }
  }, 20_000);

  it('prevents cancelled dispatched jobs from executing', async () => {
    const created = await createFixture({ priority: 180 });
    await dispatchAutomationJobs(registry, { userId });
    await cancelAutomationJob(created.id, userId);
    let executions = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-cancel',
      prefix,
      concurrency: 1,
      handler: async () => { executions += 1; },
    });
    try {
      await waitForState(registry.queue('applications'), queueJobId(created.id, 1), 'removed');
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ status: JobStatus.CANCELLED, attemptCount: 0 });
    } finally {
      await worker.close();
    }
  }, 20_000);

  it('waits for an active handler during graceful worker drain', async () => {
    const created = await createFixture({ priority: 190 });
    await dispatchAutomationJobs(registry, { userId });
    let started!: () => void;
    let release!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    const handlerReleased = new Promise<void>((resolve) => { release = resolve; });
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-graceful-drain',
      prefix,
      concurrency: 1,
      handler: async () => {
        started();
        await handlerReleased;
      },
    });
    await handlerStarted;
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    release();
    await closing;
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: JobStatus.SUCCEEDED, attemptCount: 1 });
  }, 20_000);

  it('retries failures with delay and dead-letters after PostgreSQL exhaustion', async () => {
    const created = await createFixture({ priority: 200, maxAttempts: 2 });
    await dispatchAutomationJobs(registry, { userId });
    let executions = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-failure',
      prefix,
      concurrency: 1,
      handler: async ({ automationJobId }) => {
        if (automationJobId === created.id) executions += 1;
        throw new Error('deterministic failure');
      },
    });
    const queue = registry.queue('applications');
    try {
      await waitForDatabaseJob(created.id, [JobStatus.DEAD_LETTER], 20_000);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } }))
        .resolves.toMatchObject({ status: JobStatus.DEAD_LETTER, attemptCount: 2, lastError: 'deterministic failure' });
      expect(executions).toBe(2);
      await expect(registry.listDeadLetters('applications')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: queueJobId(created.id, 2), message: expect.objectContaining({ automationJobId: created.id }) }),
      ]));
      const dead = new Queue(deadLetterQueueName('applications'), { connection, prefix });
      await expect(dead.getJob(queueJobId(created.id, 2))).resolves.toBeTruthy();
      await dead.close();
    } finally {
      await worker.close();
    }
  }, 30_000);
});
