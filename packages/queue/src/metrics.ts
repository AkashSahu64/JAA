import type { QueueName } from './names';
import { AutomationQueueRegistry } from './registry';

export interface QueueMetrics {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  completed: number;
  failed: number;
  paused: number;
}

export async function collectQueueMetrics(registry: AutomationQueueRegistry, names: readonly QueueName[]): Promise<QueueMetrics[]> {
  return Promise.all(names.map(async (name) => {
    const [counts, paused] = await Promise.all([
      registry.queue(name).getJobCounts('wait', 'active', 'delayed', 'prioritized', 'completed', 'failed'),
      registry.queue(name).isPaused(),
    ]);
    return {
      queue: name,
      waiting: counts.wait ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: paused ? 1 : 0,
    };
  }));
}
