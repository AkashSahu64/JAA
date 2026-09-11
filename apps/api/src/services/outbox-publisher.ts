import { randomUUID } from 'node:crypto';
import { Prisma, type OutboxEvent } from '@prisma/client';
import { prisma } from '@jobagent/database';

export interface OutboxEnvelope {
  id: string;
  userId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.JsonValue;
  schemaVersion: number;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: Date;
  publishAttempts: number;
}

export type OutboxTransport = (event: OutboxEnvelope) => Promise<void>;

export interface PublishOutboxOptions {
  workerId?: string;
  userId?: string;
  batchSize?: number;
  maxAttempts?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  now?: Date;
  afterPublish?: (event: OutboxEnvelope) => Promise<void>;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}

function validateOptions(options: Required<Omit<PublishOutboxOptions, 'afterPublish' | 'userId'>>): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === 'workerId' || name === 'now') continue;
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (!options.workerId.trim()) throw new Error('workerId is required');
}

async function claimEvents(
  workerId: string,
  userId: string | undefined,
  batchSize: number,
  maxAttempts: number,
  leaseMs: number,
  now: Date,
): Promise<OutboxEvent[]> {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  return prisma.$transaction(async (tx) => {
    await tx.outboxEvent.updateMany({
      where: {
        publishedAt: null,
        failedAt: null,
        leaseExpiresAt: { lte: now },
        publishAttempts: { gte: maxAttempts },
        ...(userId ? { userId } : {}),
      },
      data: {
        failedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: 'Publisher lease expired after the final permitted attempt',
      },
    });
    return tx.$queryRaw<OutboxEvent[]>`
    WITH ready AS (
      SELECT id
      FROM outbox_events
      WHERE "publishedAt" IS NULL
        AND "failedAt" IS NULL
        AND (${userId ?? null}::text IS NULL OR "userId" = ${userId ?? null})
        AND "availableAt" <= ${now}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        AND "publishAttempts" < ${maxAttempts}
      ORDER BY "occurredAt", id
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE outbox_events AS event
    SET "leaseOwner" = ${workerId},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "publishAttempts" = event."publishAttempts" + 1
    FROM ready
    WHERE event.id = ready.id
    RETURNING event.*
  `;
  });
}

function envelope(event: OutboxEvent): OutboxEnvelope {
  return {
    id: event.id,
    userId: event.userId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    correlationId: event.correlationId,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    publishAttempts: event.publishAttempts,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 10_000) : String(error).slice(0, 10_000);
}

export async function publishOutboxBatch(
  transport: OutboxTransport,
  options: PublishOutboxOptions = {},
): Promise<PublishOutboxResult> {
  const configured = {
    workerId: options.workerId ?? `outbox-${randomUUID()}`,
    batchSize: options.batchSize ?? 50,
    maxAttempts: options.maxAttempts ?? 8,
    leaseMs: options.leaseMs ?? 30_000,
    baseRetryMs: options.baseRetryMs ?? 1_000,
    now: options.now ?? new Date(),
  };
  validateOptions(configured);
  const events = await claimEvents(configured.workerId, options.userId, configured.batchSize, configured.maxAttempts, configured.leaseMs, configured.now);
  const result: PublishOutboxResult = { claimed: events.length, published: 0, retried: 0, failed: 0 };

  for (const event of events) {
    const message = envelope(event);
    try {
      await transport(message);
      await options.afterPublish?.(message);
      const marked = await prisma.outboxEvent.updateMany({
        where: { id: event.id, leaseOwner: configured.workerId, publishedAt: null, failedAt: null },
        data: { publishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null },
      });
      if (marked.count !== 1) throw new Error(`Lost outbox lease for ${event.id}`);
      result.published += 1;
    } catch (error) {
      const terminal = event.publishAttempts >= configured.maxAttempts;
      const retryDelay = configured.baseRetryMs * 2 ** Math.max(0, event.publishAttempts - 1);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, leaseOwner: configured.workerId, publishedAt: null, failedAt: null },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: errorMessage(error),
          ...(terminal ? { failedAt: new Date() } : { availableAt: new Date(configured.now.getTime() + retryDelay) }),
        },
      });
      if (terminal) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
