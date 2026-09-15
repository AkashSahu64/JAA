import 'dotenv/config';
import type { Server } from 'node:http';
import { prisma } from '@jobagent/database';
import { createApp } from './app';
import { writeStructuredLog } from './observability/structured-log';
import { validateRuntimeConfiguration } from './runtime-config';
import { startSseRedisBridge } from './services/sse-redis-bridge';
import { closeApplicationQueueMetrics } from './services/queue-metrics';

export const app = createApp();

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
  const sseBridge = startSseRedisBridge();
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    writeStructuredLog('info', { event: 'api.server_started', port });
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await closeHttpServer(server);
    } finally {
      await sseBridge.close();
      await closeApplicationQueueMetrics();
      await prisma.$disconnect();
    }
  };
  const handleShutdownFailure = (error: unknown) => writeStructuredLog('error', {
    event: 'api.server_shutdown_failure',
    error: error instanceof Error ? error.message : 'unknown error',
  });
  process.once('SIGINT', () => { void close().catch(handleShutdownFailure); });
  process.once('SIGTERM', () => { void close().catch(handleShutdownFailure); });
  return server;
}

if (process.env.NODE_ENV !== 'test') startHttpServer();

export default app;
