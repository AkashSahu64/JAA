import { type TenantTransaction } from '@jobagent/database';
import { executeIdempotentCommand, type IdempotentCommandResult } from './idempotency';
import type { OutboxEnvelope } from './outbox-publisher';

export interface ConsumeOutboxEventOptions<T extends IdempotentCommandResult> {
  consumer: string;
  event: OutboxEnvelope;
  handle: (tx: TenantTransaction, event: OutboxEnvelope) => Promise<T>;
}

export async function consumeOutboxEvent<T extends IdempotentCommandResult>(
  options: ConsumeOutboxEventOptions<T>,
): Promise<T & { replayed: boolean }> {
  if (!options.consumer.trim()) throw new Error('consumer is required');
  return executeIdempotentCommand({
    userId: options.event.userId ?? undefined,
    scope: `outbox-consumer:${options.consumer}`,
    key: options.event.idempotencyKey,
    request: {
      eventId: options.event.id,
      eventType: options.event.eventType,
      schemaVersion: options.event.schemaVersion,
      payload: options.event.payload,
    },
  }, (tx) => options.handle(tx, options.event));
}
