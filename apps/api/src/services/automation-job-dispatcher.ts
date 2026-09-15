import { randomUUID } from 'node:crypto';
import { JobStatus, type AutomationJob } from '@prisma/client';
import { withService, withTenant } from '@jobagent/database';
import { AutomationQueueRegistry } from '@jobagent/queue';
import { safeErrorMessage } from '../observability/structured-log';

export interface DispatchAutomationJobsOptions {
  batchSize?: number;
  now?: Date;
  userId?: string;
}

export interface DispatchAutomationJobsResult {
  selected: number;
  dispatched: number;
  failed: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

async function selectDispatchable(batchSize: number, now: Date, userId?: string): Promise<AutomationJob[]> {
  return withService((tx) => tx.$queryRaw<AutomationJob[]>`
    SELECT job.*
    FROM automation_jobs AS job
    LEFT JOIN automation_runs AS run ON run.id = job."automationRunId"
    WHERE job.status IN ('PENDING', 'AVAILABLE')
      AND job."availableAt" <= ${now}
      AND job."cancelledAt" IS NULL
      AND job."attemptCount" < job."maxAttempts"
      AND (${userId ?? null}::text IS NULL OR job."userId" = ${userId ?? null})
      AND (run.id IS NULL OR run.status = 'RUNNING')
    ORDER BY job.priority DESC, job."availableAt", job."createdAt", job.id
    LIMIT ${batchSize}
  `);
}

function dispatchAvailableAt(job: AutomationJob): Date {
  return job.attemptCount === 0 && job.requestedAvailableAt
    ? job.requestedAvailableAt
    : job.availableAt;
}

export async function dispatchAutomationJobs(
  registry: AutomationQueueRegistry,
  options: DispatchAutomationJobsOptions = {},
): Promise<DispatchAutomationJobsResult> {
  const batchSize = options.batchSize ?? 100;
  positiveInteger(batchSize, 'batchSize');
  const now = options.now ?? new Date();
  const jobs = await selectDispatchable(batchSize, now, options.userId);
  const result = { selected: jobs.length, dispatched: 0, failed: 0 };

  for (const job of jobs) {
    try {
      await registry.enqueue({
        automationJobId: job.id,
        type: job.type,
        correlationId: job.correlationId,
        payloadVersion: job.payloadVersion,
        deliveryGeneration: job.deliveryGeneration,
        priority: job.priority,
        availableAt: dispatchAvailableAt(job),
        dispatchAttempt: job.attemptCount + 1,
        maxAttempts: Math.max(1, job.maxAttempts - job.attemptCount),
      });
      result.dispatched += 1;
    } catch (error) {
      result.failed += 1;
      await withTenant(job.userId, (tx) => tx.auditLog.create({
        data: {
          userId: job.userId,
          action: 'AUTOMATION_JOB_DISPATCH_FAILED',
          resource: 'AutomationJob',
          resourceId: job.id,
          details: {
            correlationId: job.correlationId,
            error: safeErrorMessage(error),
            dispatchId: randomUUID(),
          },
        },
      }));
    }
  }
  return result;
}
