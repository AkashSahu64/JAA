import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { prisma } from '@jobagent/database';
import { QUEUE_NAMES, type QueueName } from '@jobagent/queue';
import { AutomationDispatcherRuntime } from './services/automation-dispatcher-runtime';
import { createProductionAutomationJobHandlers } from './services/automation-job-handlers';
import { startAutomationWorker, type AutomationJobHandler } from './services/automation-worker';

const handlers = new Map<string, AutomationJobHandler>(createProductionAutomationJobHandlers());

export function registerAutomationJobHandler(type: string, handler: AutomationJobHandler): void {
  if (!type.trim()) throw new Error('Automation job handler type is required');
  handlers.set(type.trim().toUpperCase(), handler);
}

export function clearAutomationJobHandlers(): void {
  handlers.clear();
}

function handlerForQueue(name: QueueName): AutomationJobHandler {
  return async (context) => {
    const handler = handlers.get(context.type.trim().toUpperCase());
    if (!handler) throw new Error(`No registered handler for ${context.type} on ${name}`);
    await handler(context);
  };
}

function positiveIntegerEnvironment(name: string, defaultValue: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;
  const concurrency = positiveIntegerEnvironment('WORKER_CONCURRENCY', 4);
  const rateLimitMax = positiveIntegerEnvironment('WORKER_RATE_LIMIT_MAX', 20);
  const rateLimitDurationMs = positiveIntegerEnvironment('WORKER_RATE_LIMIT_DURATION_MS', 1_000);
  const dispatcher = new AutomationDispatcherRuntime();
  const workers = QUEUE_NAMES.map((name) => startAutomationWorker({
    name,
    workerId: `${workerId}:${name}`,
    concurrency,
    limiter: { max: rateLimitMax, duration: rateLimitDurationMs },
    handler: handlerForQueue(name),
  }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await dispatcher.close();
    await Promise.all(workers.map((worker) => worker.close()));
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  await dispatcher.start();
  console.log(`Automation worker runtime started as ${workerId}`);
}

if (process.env.NODE_ENV !== 'test') {
  void main().catch(async (error) => {
    console.error('Automation worker runtime failed', error);
    await prisma.$disconnect();
    process.exit(1);
  });
}
