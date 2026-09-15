import type { QueueName } from './names';
import { AutomationQueueRegistry } from './registry';

export interface QueueMetrics {
  queue: QueueName;
  waiting: number;
  /** Age of the oldest currently waiting/prioritized job, or null when empty. */
  oldestWaitingMs: number | null;
  active: number;
  delayed: number;
  prioritized: number;
  completed: number;
  failed: number;
  paused: number;
}

const MAX_QUEUE_COUNT = 1_000_000_000;

/** Keep operational telemetry finite and non-negative even if Redis returns corrupt values. */
function boundedQueueCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_QUEUE_COUNT)
    : 0;
}

export async function collectQueueMetrics(registry: AutomationQueueRegistry, names: readonly QueueName[]): Promise<QueueMetrics[]> {
  return Promise.all(names.map(async (name) => {
    const [counts, paused, waitingJobs] = await Promise.all([
      registry.queue(name).getJobCounts('wait', 'active', 'delayed', 'prioritized', 'completed', 'failed'),
      registry.queue(name).isPaused(),
      registry.queue(name).getJobs(['wait', 'prioritized'], 0, 0, true),
    ]);
    const oldestTimestamp = waitingJobs.reduce<number | null>((oldest, job) => {
      const timestamp = Number(job.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) return oldest;
      return oldest === null ? timestamp : Math.min(oldest, timestamp);
    }, null);
    const oldestWaitingMs = oldestTimestamp === null ? null : Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, Date.now() - oldestTimestamp));
    return {
      queue: name,
      waiting: boundedQueueCount(counts.wait),
      oldestWaitingMs,
      active: boundedQueueCount(counts.active),
      delayed: boundedQueueCount(counts.delayed),
      prioritized: boundedQueueCount(counts.prioritized),
      completed: boundedQueueCount(counts.completed),
      failed: boundedQueueCount(counts.failed),
      paused: paused ? 1 : 0,
    };
  }));
}
