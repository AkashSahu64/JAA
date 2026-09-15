import { AutomationQueueRegistry, collectQueueMetrics, QUEUE_NAMES } from '@jobagent/queue';

let registry: AutomationQueueRegistry | undefined;

export async function collectApplicationQueueMetrics() {
  registry ??= new AutomationQueueRegistry();
  return collectQueueMetrics(registry, QUEUE_NAMES);
}

export async function closeApplicationQueueMetrics(): Promise<void> {
  const active = registry;
  registry = undefined;
  if (active) await active.close();
}

