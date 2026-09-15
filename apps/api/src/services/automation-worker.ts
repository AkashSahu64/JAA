import { JobStatus, Prisma } from '@prisma/client';
import { withService } from '@jobagent/database';
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
import { safeErrorMessage, writeStructuredLog } from '../observability/structured-log';
import type { StructuredLogRecord } from '../observability/structured-log';

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

function payloadIdentifier(payload: Prisma.JsonValue, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, Prisma.JsonValue>)[key];
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function jobTraceContext(job: { payload: Prisma.JsonValue }): Pick<StructuredLogRecord, 'applicationId' | 'provider'> {
  return {
    applicationId: payloadIdentifier(job.payload, 'applicationId'),
    provider: payloadIdentifier(job.payload, 'provider') ?? payloadIdentifier(job.payload, 'providerName'),
  };
}

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
  return withService((tx) => tx.automationJob.findFirst({
    where: {
      id: message.automationJobId,
      status: JobStatus.LEASED,
      deliveryGeneration: message.deliveryGeneration,
      leaseOwner: workerId,
      leaseExpiresAt: { gt: new Date() },
    },
  }));
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
    const startedAt = Date.now();
    try {
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
    } finally {
      writeStructuredLog('info', {
        event: 'automation.job_execution_duration', automationJobId: job.id, userId: job.userId,
        correlationId: job.correlationId, jobType: job.type, attempt: job.attemptCount,
        workerId: context.workerId, durationMs: Math.max(0, Date.now() - startedAt), ...jobTraceContext(job),
      });
    }
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
    onHeartbeatError: (message, error) => {
      writeStructuredLog('error', {
        event: 'automation.lease_renewal_failure', automationJobId: message.automationJobId,
        correlationId: message.correlationId, jobType: message.type,
        errorName: error.name, errorMessage: safeErrorMessage(error), workerId: options.workerId,
      });
    },
    onWorkerError: (error) => {
      writeStructuredLog('error', {
        event: 'automation.worker_error',
        errorName: error.name,
        errorMessage: safeErrorMessage(error),
        workerId: options.workerId,
        queue: options.name,
      });
    },
    isLeaseLost: (error) => error instanceof AutomationJobError && error.code === 'LEASE_LOST',
    onComplete: async (message, result) => {
      if (result && result.outcome === 'SKIPPED') return;
      const job = await loadOwnedJob(message, options.workerId);
      if (job) await completeAutomationJob({ jobId: message.automationJobId, workerId: options.workerId });
    },
    shouldRetry: async (message) => {
      const job = await withService((tx) => tx.automationJob.findUnique({
        where: { id: message.automationJobId },
        select: { status: true },
      }));
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
      const failure = error instanceof Error ? error : new Error('Unknown automation failure');
      const job = await loadOwnedJob(message, options.workerId);
      writeStructuredLog('error', {
        event: 'automation.job_failure', automationJobId: message.automationJobId,
        correlationId: message.correlationId, jobType: message.type,
        attempt: message.dispatchAttempt, errorName: failure.name,
        errorMessage: safeErrorMessage(failure), retryDelayMs, workerId: options.workerId,
        ...(job ? jobTraceContext(job) : {}),
      });
      if (!job) return 'IGNORED';
      const updated = await failAutomationJob({
        jobId: message.automationJobId,
        workerId: options.workerId,
        error: safeErrorMessage(failure),
        retryDelayMs,
        providerRetryAfterMs: error instanceof AutomationJobRetryError ? error.retryAfterMs : undefined,
      });
      return updated.status === JobStatus.DEAD_LETTER ? 'DEAD_LETTER' : 'RETRY';
    },
    url: options.url,
    prefix: options.prefix,
  });
}
