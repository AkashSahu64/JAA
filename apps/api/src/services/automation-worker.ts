import { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '@jobagent/database';
import {
  AutomationQueueWorker,
  type AutomationProcessor,
  type AutomationQueueMessage,
  type AutomationWorkerOptions,
  type QueueName,
} from '@jobagent/queue';
import {
  AutomationJobError,
  AutomationJobRetryError,
  completeAutomationJob,
  failAutomationJob,
  leaseAutomationJob,
  renewAutomationJobLease,
  validateAutomationJobRetry,
} from './automation-jobs';

export interface AutomationJobHandlerContext {
  automationJobId: string;
  userId: string;
  type: string;
  payload: Prisma.JsonValue;
  payloadVersion: number;
  correlationId: string;
  deliveryGeneration: number;
  attempt: number;
  workerId: string;
  signal: AbortSignal;
  heartbeat: () => Promise<void>;
}

export type AutomationJobHandler = (context: AutomationJobHandlerContext) => Promise<void>;

export interface StartAutomationWorkerOptions {
  name: QueueName;
  workerId: string;
  handler: AutomationJobHandler;
  concurrency?: number;
  limiter?: AutomationWorkerOptions['limiter'];
  leaseMs?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  url?: string;
  prefix?: string;
}

async function loadOwnedJob(message: AutomationQueueMessage, workerId: string) {
  return prisma.automationJob.findFirst({
    where: {
      id: message.automationJobId,
      status: JobStatus.LEASED,
      deliveryGeneration: message.deliveryGeneration,
      leaseOwner: workerId,
      leaseExpiresAt: { gt: new Date() },
    },
  });
}

function processor(options: StartAutomationWorkerOptions): AutomationProcessor {
  return async (message, context) => {
    const job = await leaseAutomationJob({
      jobId: message.automationJobId,
      workerId: options.workerId,
      deliveryGeneration: message.deliveryGeneration,
      expectedAttempt: message.dispatchAttempt,
      leaseMs: options.leaseMs,
    });
    if (!job) return { outcome: 'SKIPPED' as const };
    if (job.payloadVersion !== message.payloadVersion || job.deliveryGeneration !== message.deliveryGeneration || job.type !== message.type || job.correlationId !== message.correlationId) {
      throw new Error('Queue envelope does not match the authoritative AutomationJob');
    }
    await options.handler({
      automationJobId: job.id,
      userId: job.userId,
      type: job.type,
      payload: job.payload,
      payloadVersion: job.payloadVersion,
      correlationId: job.correlationId,
      deliveryGeneration: job.deliveryGeneration,
      attempt: job.attemptCount,
      workerId: context.workerId,
      signal: context.signal,
      heartbeat: context.heartbeat,
    });
    return { outcome: 'EXECUTED' as const };
  };
}

export function startAutomationWorker(options: StartAutomationWorkerOptions): AutomationQueueWorker {
  const leaseMs = options.leaseMs ?? 30_000;
  return new AutomationQueueWorker(options.name, {
    workerId: options.workerId,
    concurrency: options.concurrency,
    limiter: options.limiter,
    leaseMs,
    lockDurationMs: options.lockDurationMs,
    stalledIntervalMs: options.stalledIntervalMs,
    maxStalledCount: options.maxStalledCount,
    processor: processor(options),
    onRenew: async (message) => {
      await renewAutomationJobLease({ jobId: message.automationJobId, workerId: options.workerId, leaseMs });
    },
    isLeaseLost: (error) => error instanceof AutomationJobError && error.code === 'LEASE_LOST',
    onComplete: async (message, result) => {
      if (result && result.outcome === 'SKIPPED') return;
      const job = await loadOwnedJob(message, options.workerId);
      if (job) await completeAutomationJob({ jobId: message.automationJobId, workerId: options.workerId });
    },
    shouldRetry: async (message) => {
      const job = await prisma.automationJob.findUnique({
        where: { id: message.automationJobId },
        select: { status: true },
      });
      return job?.status === JobStatus.AVAILABLE;
    },
    onRetry: async (message, { nextDispatchAttempt, deliveryGeneration }) => {
      await validateAutomationJobRetry({
        jobId: message.automationJobId,
        deliveryGeneration,
        expectedAttempt: message.dispatchAttempt,
        nextDispatchAttempt,
      });
    },
    onFailure: async (message, error, retryDelayMs) => {
      const job = await loadOwnedJob(message, options.workerId);
      if (!job) return 'IGNORED';
      const updated = await failAutomationJob({
        jobId: message.automationJobId,
        workerId: options.workerId,
        error: error.message,
        retryDelayMs,
        providerRetryAfterMs: error instanceof AutomationJobRetryError ? error.retryAfterMs : undefined,
      });
      return updated.status === JobStatus.DEAD_LETTER ? 'DEAD_LETTER' : 'RETRY';
    },
    url: options.url,
    prefix: options.prefix,
  });
}
