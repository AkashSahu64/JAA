import 'dotenv/config';
import type { Server } from 'node:http';
import { prisma } from '@jobagent/database';
import { createApp } from './app';
import { writeStructuredLog } from './observability/structured-log';
import { validateRuntimeConfiguration } from './runtime-config';
import { startSseRedisBridge } from './services/sse-redis-bridge';
import { closeApplicationQueueMetrics } from './services/queue-metrics';

export const app = createApp();
const MAX_HTTP_SHUTDOWN_TIMEOUT_MS = 120_000;

export async function closeHttpResources(resources: readonly (() => Promise<void>)[], timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('HTTP shutdown timeout must be a positive integer');
  const results = await Promise.allSettled(resources.map(async closeResource => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closeResource(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('HTTP resource did not close before the shutdown timeout')), timeoutMs);
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

export function httpShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const timeoutMs = env.HTTP_SHUTDOWN_TIMEOUT_MS === undefined ? 30_000 : Number(env.HTTP_SHUTDOWN_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_HTTP_SHUTDOWN_TIMEOUT_MS) throw new Error('HTTP_SHUTDOWN_TIMEOUT_MS must be between one second and two minutes');
  return timeoutMs;
}

export function handleHttpShutdownFailure(error: unknown, exit: (code: number) => never = process.exit): never {
  writeStructuredLog('error', {
    event: 'api.server_shutdown_failure',
    error: error instanceof Error ? error.message : 'unknown error',
  });
  exit(1);
}

export async function closeHttpServer(server: Pick<Server, 'close'> & { closeAllConnections?: () => void }, timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('HTTP shutdown timeout must be a positive integer');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.closeAllConnections?.();
      reject(new Error('HTTP server did not stop before the shutdown timeout'));
    }, timeoutMs);
    server.close(error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

export function startHttpServer(): Server {
  validateRuntimeConfiguration();
  const shutdownTimeoutMs = httpShutdownTimeoutMs();
  const sseBridge = startSseRedisBridge();
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    writeStructuredLog('info', { event: 'api.server_started', port });
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await closeHttpResources([
      () => closeHttpServer(server, shutdownTimeoutMs),
      () => sseBridge.close(),
      () => closeApplicationQueueMetrics(),
      () => prisma.$disconnect(),
    ], shutdownTimeoutMs);
  };
  process.once('SIGINT', () => { void close().catch(error => handleHttpShutdownFailure(error)); });
  process.once('SIGTERM', () => { void close().catch(error => handleHttpShutdownFailure(error)); });
  return server;
}

if (process.env.NODE_ENV !== 'test') startHttpServer();

export default app;
