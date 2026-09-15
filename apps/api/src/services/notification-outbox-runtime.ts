import { randomUUID } from 'node:crypto';
import { broadcastToUser } from '../routes/sse';
import { consumeNotificationOutboxEvent, mapOutboxEventToNotification } from './notification-outbox-consumer';
import { publishOutboxBatch } from './outbox-publisher';
import { publishSseEvent } from './sse-redis-bridge';

export interface NotificationOutboxRuntimeOptions {
  intervalMs?: number;
  batchSize?: number;
  shutdownTimeoutMs?: number;
  workerId?: string;
  onError?: (error: unknown) => void;
}

/**
 * Durable notification delivery loop. The database outbox remains the source
 * of truth; this loop only claims leased events and delegates retries to the
 * existing publisher.
 */
export function startNotificationOutboxRuntime(options: NotificationOutboxRuntimeOptions = {}): { close: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? 1_000;
  const batchSize = options.batchSize ?? 50;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) throw new Error('Notification outbox interval must be at least 250ms');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Notification outbox batch size must be between 1 and 500');
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000) throw new Error('Notification outbox shutdown timeout must be at least one second');
  const workerId = options.workerId?.trim() || `notifications-${randomUUID()}`;
  let running = false;
  let closed = false;

  const tick = async () => {
    if (closed || running) return;
    running = true;
    try {
      await publishOutboxBatch(async event => {
        const result = await consumeNotificationOutboxEvent(event);
        const notification = mapOutboxEventToNotification(event);
        if (result.responseBody && typeof result.responseBody === 'object' && !Array.isArray(result.responseBody)
          && (result.responseBody as Record<string, unknown>).consumed === true && notification && event.userId) {
          broadcastToUser(event.userId, { id: notification.id, type: 'notification', data: notification });
          if (process.env.NODE_ENV !== 'test') {
            try {
              await publishSseEvent({ userId: event.userId, id: notification.id, type: 'notification', data: notification });
            } catch (error) {
              options.onError?.(error);
            }
          }
        }
      }, { workerId, batchSize });
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return {
    close: async () => {
      closed = true;
      clearInterval(timer);
      const deadline = Date.now() + shutdownTimeoutMs;
      while (running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (running) throw new Error('Notification outbox runtime did not stop before the shutdown timeout');
    },
  };
}
