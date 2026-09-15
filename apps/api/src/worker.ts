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
  const concurrency = positiveIntegerEnvironment('WORKER_CONCURRENCY', 4);
  const rateLimitMax = positiveIntegerEnvironment('WORKER_RATE_LIMIT_MAX', 20);
  const rateLimitDurationMs = positiveIntegerEnvironment('WORKER_RATE_LIMIT_DURATION_MS', 1_000);
  const dispatcher = new AutomationDispatcherRuntime();
  const recoveredBrowserSessions = await reconcileStaleBrowserSessions();
  if (recoveredBrowserSessions > 0) writeStructuredLog('warn', { event: 'browser.sessions_recovered', count: recoveredBrowserSessions, workerId });
  const documentRetention = new DocumentRetentionRuntime({
    intervalMs: positiveIntegerEnvironment('DOCUMENT_RETENTION_INTERVAL_MS', 60 * 60 * 1_000),
    onError: error => writeStructuredLog('error', { event: 'document_retention.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }),
  });
  const schedulerIntervalMs = positiveIntegerEnvironment('SCHEDULER_INTERVAL_MS', 60_000);
  const scheduler = startDurableScheduler({ intervalMs: schedulerIntervalMs, onError: error => writeStructuredLog('error', { event: 'scheduler.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }) });
  const notificationOutbox = startNotificationOutboxRuntime({
    intervalMs: positiveIntegerEnvironment('NOTIFICATION_OUTBOX_INTERVAL_MS', 1_000),
    batchSize: positiveIntegerEnvironment('NOTIFICATION_OUTBOX_BATCH_SIZE', 50),
    workerId: `${workerId}:notifications`,
    onError: error => writeStructuredLog('error', { event: 'notification_outbox.tick_failure', error: error instanceof Error ? error.message : 'unknown error', workerId }),
  });
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
    await scheduler.close();
    await notificationOutbox.close();
    await documentRetention.close();
    await dispatcher.close();
    await Promise.all(workers.map((worker) => worker.close()));
    await closeSseRedisBridge();
    await disconnectService();
    await prisma.$disconnect();
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
  await dispatcher.start();
  await documentRetention.start();
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
