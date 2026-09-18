import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { disconnectService, prisma } from '@jobagent/database';
import { QUEUE_NAMES, redisConnection, type QueueName } from '@jobagent/queue';
import { AutomationDispatcherRuntime } from './services/automation-dispatcher-runtime';
import { createProductionAutomationJobHandlers } from './services/automation-job-handlers';
import { startAutomationWorker, type AutomationJobHandler } from './services/automation-worker';
import { startDurableScheduler } from './services/durable-scheduler';
import { startNotificationOutboxRuntime } from './services/notification-outbox-runtime';
import { DocumentRetentionRuntime } from './services/document-retention-runtime';
import { writeStructuredLog } from './observability/structured-log';
import { validateProductionDatabaseUrl, validateProductionRedisUrl } from './runtime-config';
import { closeSseRedisBridge } from './services/sse-redis-bridge';
import { reconcileStaleBrowserSessions } from './services/browser-session-manager';

const handlers = new Map<string, AutomationJobHandler>(createProductionAutomationJobHandlers());
const MAX_WORKER_SHUTDOWN_TIMEOUT_MS = 120_000;
const MAX_WORKER_CONCURRENCY = 100;
const MAX_WORKER_RATE_LIMIT_MAX = 10_000;
const MAX_WORKER_RATE_LIMIT_DURATION_MS = 120_000;

export function registerAutomationJobHandler(type: string, handler: AutomationJobHandler): void {
  if (!type.trim()) throw new Error('Automation job handler type is required');
  handlers.set(type.trim().toUpperCase(), handler);
}

export function clearAutomationJobHandlers(): void {
  handlers.clear();
}

/** Close every worker-owned resource, preserving the first failure for the process exit path. */
export async function closeWorkerResources(resources: readonly (() => Promise<void>)[], timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WORKER_SHUTDOWN_TIMEOUT_MS) throw new Error('Worker shutdown timeout must be between one millisecond and two minutes');
  const results = await Promise.allSettled(resources.map(async closeResource => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closeResource(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Worker resource did not close before the shutdown timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (firstFailure) throw firstFailure.reason;
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

function boundedIntegerEnvironment(name: string, defaultValue: number, minimum: number, maximum?: number): number {
  const value = positiveIntegerEnvironment(name, defaultValue);
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    throw new Error(`${name} must be between ${minimum} and ${maximum ?? 'the safe integer limit'}`);
  }
  return value;
}

export function validateWorkerRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const required: Array<[string, string | undefined]> = [
    ['DATABASE_URL', env.DATABASE_URL],
    ['DATABASE_ADMIN_URL', env.DATABASE_ADMIN_URL],
    ['REDIS_URL', env.REDIS_URL],
    ['S3_DOCUMENT_BUCKET', env.S3_DOCUMENT_BUCKET],
    ['DOCUMENT_SCANNER_COMMAND', env.DOCUMENT_SCANNER_COMMAND],
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required production worker configuration: ${missing.join(', ')}`);
  if (env.DOCUMENT_RETENTION_INTERVAL_MS !== undefined) {
    const interval = Number(env.DOCUMENT_RETENTION_INTERVAL_MS);
    if (!Number.isSafeInteger(interval) || interval < 1_000) throw new Error('DOCUMENT_RETENTION_INTERVAL_MS must be at least one second');
  }
  if (env.SCHEDULER_INTERVAL_MS !== undefined) {
    const interval = Number(env.SCHEDULER_INTERVAL_MS);
    if (!Number.isSafeInteger(interval) || interval < 1_000) throw new Error('SCHEDULER_INTERVAL_MS must be at least one second');
  }
  if (env.NOTIFICATION_OUTBOX_INTERVAL_MS !== undefined) {
    const interval = Number(env.NOTIFICATION_OUTBOX_INTERVAL_MS);
    if (!Number.isSafeInteger(interval) || interval < 250) throw new Error('NOTIFICATION_OUTBOX_INTERVAL_MS must be at least 250ms');
  }
  if (env.NOTIFICATION_OUTBOX_BATCH_SIZE !== undefined) {
    const batchSize = Number(env.NOTIFICATION_OUTBOX_BATCH_SIZE);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('NOTIFICATION_OUTBOX_BATCH_SIZE must be between 1 and 500');
  }
  if (env.WORKER_CONCURRENCY !== undefined) {
    const concurrency = Number(env.WORKER_CONCURRENCY);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKER_CONCURRENCY) throw new Error('WORKER_CONCURRENCY must be between 1 and 100');
  }
  if (env.WORKER_RATE_LIMIT_MAX !== undefined) {
    const maximum = Number(env.WORKER_RATE_LIMIT_MAX);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_WORKER_RATE_LIMIT_MAX) throw new Error('WORKER_RATE_LIMIT_MAX must be between 1 and 10000');
  }
  if (env.WORKER_RATE_LIMIT_DURATION_MS !== undefined) {
    const duration = Number(env.WORKER_RATE_LIMIT_DURATION_MS);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_WORKER_RATE_LIMIT_DURATION_MS) throw new Error('WORKER_RATE_LIMIT_DURATION_MS must be between 1 and 120000');
  }
  if (env.WORKER_SHUTDOWN_TIMEOUT_MS !== undefined) {
    const timeout = Number(env.WORKER_SHUTDOWN_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_WORKER_SHUTDOWN_TIMEOUT_MS) throw new Error('WORKER_SHUTDOWN_TIMEOUT_MS must be between one second and two minutes');
  }
  try {
    validateProductionRedisUrl(env.REDIS_URL!);
    redisConnection({ url: env.REDIS_URL });
    validateProductionDatabaseUrl(env.DATABASE_URL!);
    validateProductionDatabaseUrl(env.DATABASE_ADMIN_URL!);
  } catch (error) {
    throw new Error(`Invalid production dependency URL: ${error instanceof Error ? error.message : 'invalid URL'}`);
  }
}

async function main(): Promise<void> {
  validateWorkerRuntimeConfiguration();
  const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;
  const concurrency = boundedIntegerEnvironment('WORKER_CONCURRENCY', 4, 1, MAX_WORKER_CONCURRENCY);
  const rateLimitMax = boundedIntegerEnvironment('WORKER_RATE_LIMIT_MAX', 20, 1, MAX_WORKER_RATE_LIMIT_MAX);
  const rateLimitDurationMs = boundedIntegerEnvironment('WORKER_RATE_LIMIT_DURATION_MS', 1_000, 1, MAX_WORKER_RATE_LIMIT_DURATION_MS);
  const shutdownTimeoutMs = positiveIntegerEnvironment('WORKER_SHUTDOWN_TIMEOUT_MS', 30_000);
  const documentRetentionIntervalMs = boundedIntegerEnvironment('DOCUMENT_RETENTION_INTERVAL_MS', 60 * 60 * 1_000, 1_000);
  const schedulerIntervalMs = boundedIntegerEnvironment('SCHEDULER_INTERVAL_MS', 60_000, 1_000);
  const notificationOutboxIntervalMs = boundedIntegerEnvironment('NOTIFICATION_OUTBOX_INTERVAL_MS', 1_000, 250);
  const notificationOutboxBatchSize = boundedIntegerEnvironment('NOTIFICATION_OUTBOX_BATCH_SIZE', 50, 1, 500);
  const recoveredBrowserSessions = await reconcileStaleBrowserSessions();
  if (recoveredBrowserSessions > 0) writeStructuredLog('warn', { event: 'browser.sessions_recovered', count: recoveredBrowserSessions, workerId });
  const dispatcher = new AutomationDispatcherRuntime({ shutdownTimeoutMs });
  const documentRetention = new DocumentRetentionRuntime({
    intervalMs: documentRetentionIntervalMs,
    shutdownTimeoutMs,
    onError: error => writeStructuredLog('error', { event: 'document_retention.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }),
  });
  const scheduler = startDurableScheduler({ intervalMs: schedulerIntervalMs, shutdownTimeoutMs, onError: error => writeStructuredLog('error', { event: 'scheduler.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }) });
  const notificationOutbox = startNotificationOutboxRuntime({
    intervalMs: notificationOutboxIntervalMs,
    batchSize: notificationOutboxBatchSize,
    shutdownTimeoutMs,
    workerId: `${workerId}:notifications`,
    onError: error => writeStructuredLog('error', { event: 'notification_outbox.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }),
  });
  const workers: ReturnType<typeof startAutomationWorker>[] = [];
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await closeWorkerResources([
      () => scheduler.close(),
      () => notificationOutbox.close(),
      () => documentRetention.close(),
      () => dispatcher.close(),
      ...workers.map(worker => () => worker.close()),
      () => closeSseRedisBridge(),
      () => disconnectService(),
      () => prisma.$disconnect(),
    ], shutdownTimeoutMs);
  };
  const handleShutdown = () => {
    void close().then(() => process.exit(0)).catch((error: unknown) => {
      writeStructuredLog('error', {
        event: 'automation.worker_shutdown_failure',
        error: error instanceof Error ? error.message : 'unknown error',
        workerId,
      });
      process.exit(1);
    });
  };
  process.once('SIGINT', handleShutdown);
  process.once('SIGTERM', handleShutdown);
  try {
    for (const name of QUEUE_NAMES) {
      workers.push(startAutomationWorker({
        name,
        workerId: `${workerId}:${name}`,
        concurrency,
        limiter: { max: rateLimitMax, duration: rateLimitDurationMs },
        handler: handlerForQueue(name),
      }));
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError: unknown) {
      writeStructuredLog('error', {
        event: 'automation.worker_start_cleanup_failure',
        error: cleanupError instanceof Error ? cleanupError.message : 'unknown error',
        workerId,
      });
    }
    throw error;
  }
  try {
    await dispatcher.start();
    await documentRetention.start();
  } catch (error) {
    // Startup can fail after several long-lived resources have already been
    // created. Reuse the bounded shutdown path so a failed boot does not leak
    // queues, timers, Redis bridges, or database connections before exit.
    try {
      await close();
    } catch (cleanupError: unknown) {
      writeStructuredLog('error', {
        event: 'automation.worker_start_cleanup_failure',
        error: cleanupError instanceof Error ? cleanupError.message : 'unknown error',
        workerId,
      });
    }
    throw error;
  }
  writeStructuredLog('info', { event: 'automation.worker_started', workerId });
}

if (process.env.NODE_ENV !== 'test') {
  void main().catch(async (error) => {
    writeStructuredLog('error', { event: 'automation.worker_start_failure', error: error instanceof Error ? error.message : 'unknown error' });
    await disconnectService();
    await prisma.$disconnect();
    process.exit(1);
  });
}
