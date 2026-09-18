import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { JobStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { AutomationQueueRegistry } from '@jobagent/queue';
import { dispatchAutomationJobs } from './automation-job-dispatcher';
import { createAutomationJob } from './automation-jobs';
import { startAutomationWorker } from './automation-worker';

const enabled = process.env.REDIS_OUTAGE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeOutage = enabled ? describe : describe.skip;
const redisPort = Number(process.env.REDIS_OUTAGE_PORT ?? 6380);

function runDocker(...args: string[]): void {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `docker compose ${args.join(' ')} failed`).trim());
}

async function redisReachable(timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: redisPort });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForRedisState(reachable: boolean, timeout = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await redisReachable() === reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Redis did not become ${reachable ? 'reachable' : 'unreachable'}`);
}

async function waitForStatus(jobId: string, status: JobStatus, timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const job = await prisma.automationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to reach ${status}`);
}

describeOutage.sequential('Redis outage recovery', () => {
  const userId = randomUUID();
  const prefix = `goal5-outage-${randomUUID()}`;
  let redisStopped = false;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Redis Outage Fixture' } });
  });

  afterAll(async () => {
    if (redisStopped) {
      runDocker('start', 'jobagent-goal5-redis-outage');
      await waitForRedisState(true);
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('preserves PostgreSQL authority and executes once after Redis restarts', async () => {
    const token = randomUUID();
    const created = await createAutomationJob({
      userId,
      // A real `applications`-routed type: the worker handler is stubbed by this test, and
      // job routing is exact-match, so an invented type would never reach this queue.
      type: 'VERIFY_SUBMISSION_CONFIRMATION',
      payload: { token },
      correlationId: randomUUID(),
      idempotencyKey: `goal5-outage:${token}`,
      maxAttempts: 3,
    });

    try {
      runDocker('stop', 'jobagent-goal5-redis-outage');
      redisStopped = true;
      await waitForRedisState(false);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
        status: JobStatus.AVAILABLE,
        attemptCount: 0,
        deliveryGeneration: 1,
        completedAt: null,
      });
    } finally {
      runDocker('start', 'jobagent-goal5-redis-outage');
      redisStopped = false;
      await waitForRedisState(true);
    }

    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    const registry = new AutomationQueueRegistry({ prefix, url: redisUrl });
    let executions = 0;
    const worker = startAutomationWorker({
      name: 'applications',
      workerId: 'goal5-outage-recovery',
      prefix,
      url: redisUrl,
      concurrency: 1,
      handler: async ({ automationJobId }) => {
        if (automationJobId === created.id) executions += 1;
      },
    });
    try {
      await expect(dispatchAutomationJobs(registry, { userId })).resolves.toMatchObject({ selected: 1, dispatched: 1, failed: 0 });
      await waitForStatus(created.id, JobStatus.SUCCEEDED);
      expect(executions).toBe(1);
      await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
        status: JobStatus.SUCCEEDED,
        attemptCount: 1,
        leaseOwner: null,
      });
    } finally {
      await worker.close();
      await registry.drain('applications');
      await registry.close();
    }
  }, 45_000);
});
