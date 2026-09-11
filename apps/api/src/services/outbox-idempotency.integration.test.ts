import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { executeIdempotentCommand } from './idempotency';
import { consumeOutboxEvent } from './outbox-consumer';
import { publishOutboxBatch, type OutboxEnvelope } from './outbox-publisher';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function eventData(userId: string, suffix: string, attempts = 0) {
  return {
    userId,
    aggregateType: 'Goal3Fixture',
    aggregateId: suffix,
    eventType: 'fixture.changed',
    payload: { suffix },
    correlationId: randomUUID(),
    idempotencyKey: `goal3:${suffix}`,
    publishAttempts: attempts,
  };
}

describeDatabase.sequential('outbox publication and durable idempotency', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 3 Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 3 Other Fixture' },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('claims each event once across concurrent publishers', async () => {
    const suffixes = Array.from({ length: 6 }, () => randomUUID());
    await prisma.outboxEvent.createMany({ data: suffixes.map((suffix) => eventData(userId, suffix)) });
    const delivered: string[] = [];
    const transport = async (event: OutboxEnvelope) => { delivered.push(event.id); };
    const results = await Promise.all([
      publishOutboxBatch(transport, { workerId: 'goal3-a', userId, batchSize: 6 }),
      publishOutboxBatch(transport, { workerId: 'goal3-b', userId, batchSize: 6 }),
    ]);
    expect(results.reduce((sum, result) => sum + result.published, 0)).toBe(6);
    expect(new Set(delivered)).toHaveLength(6);
  });

  it('retries failures with backoff and records terminal exhaustion', async () => {
    const retrySuffix = randomUUID();
    const failedSuffix = randomUUID();
    const now = new Date();
    await prisma.outboxEvent.create({ data: { ...eventData(userId, retrySuffix), availableAt: new Date(now.getTime() - 1_000) } });
    await expect(publishOutboxBatch(async () => { throw new Error('transport unavailable'); }, {
      workerId: 'goal3-retry', userId, batchSize: 1, baseRetryMs: 2_000, now,
    })).resolves.toMatchObject({ retried: 1 });
    await expect(prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `goal3:${retrySuffix}` } }))
      .resolves.toMatchObject({ publishAttempts: 1, lastError: 'transport unavailable', failedAt: null, availableAt: new Date(now.getTime() + 2_000) });

    await prisma.outboxEvent.create({ data: {
      ...eventData(userId, failedSuffix, 1),
      availableAt: new Date(now.getTime() - 1_000),
    } });
    await expect(publishOutboxBatch(async () => { throw new Error('permanent failure'); }, {
      workerId: 'goal3-failed', userId, batchSize: 1, maxAttempts: 2,
    })).resolves.toMatchObject({ failed: 1 });
    await expect(prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `goal3:${failedSuffix}` } }))
      .resolves.toMatchObject({ publishAttempts: 2, lastError: 'permanent failure', failedAt: expect.any(Date) });
  });

  it('redelivers after a crash following send but before publication marking', async () => {
    const suffix = randomUUID();
    await prisma.outboxEvent.create({ data: { ...eventData(userId, suffix), occurredAt: new Date(Date.now() - 60_000), availableAt: new Date(0) } });
    const deliveries: string[] = [];
    const transport = async (event: OutboxEnvelope) => { deliveries.push(event.idempotencyKey); };
    await expect(publishOutboxBatch(transport, {
      workerId: 'goal3-crash', userId, batchSize: 1, baseRetryMs: 1,
      afterPublish: async () => { throw new Error('simulated crash after send'); },
    })).resolves.toMatchObject({ retried: 1 });
    await prisma.outboxEvent.update({ where: { idempotencyKey: `goal3:${suffix}` }, data: { availableAt: new Date(0) } });
    await expect(publishOutboxBatch(transport, { workerId: 'goal3-restart', userId, batchSize: 1 }))
      .resolves.toMatchObject({ published: 1 });
    expect(deliveries).toEqual([`goal3:${suffix}`, `goal3:${suffix}`]);
  });

  it('fails an expired final-attempt publisher lease', async () => {
    const suffix = randomUUID();
    const now = new Date();
    await prisma.outboxEvent.create({ data: {
      ...eventData(userId, suffix, 2),
      leaseOwner: 'goal3-dead-worker',
      leaseExpiresAt: new Date(now.getTime() - 1),
    } });
    await expect(publishOutboxBatch(async () => {}, {
      workerId: 'goal3-reaper', userId, maxAttempts: 2, now,
    })).resolves.toMatchObject({ claimed: 0 });
    await expect(prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `goal3:${suffix}` } }))
      .resolves.toMatchObject({ failedAt: expect.any(Date), leaseOwner: null, lastError: 'Publisher lease expired after the final permitted attempt' });
  });

  it('deduplicates repeated consumer delivery with the event idempotency key', async () => {
    const suffix = randomUUID();
    const stored = await prisma.outboxEvent.create({ data: eventData(userId, suffix) });
    const event: OutboxEnvelope = { ...stored, userId, publishAttempts: 1 };
    let effects = 0;
    const consume = () => consumeOutboxEvent({
      consumer: 'goal3-notifications',
      event,
      handle: async (tx) => {
        effects += 1;
        await tx.notification.create({ data: { userId, type: 'GOAL3', title: 'Consumed', message: suffix } });
        return { responseCode: 204, responseBody: { consumed: true } };
      },
    });
    await expect(consume()).resolves.toMatchObject({ replayed: false });
    await expect(consume()).resolves.toMatchObject({ replayed: true });
    expect(effects).toBe(1);
    await expect(prisma.notification.count({ where: { userId, message: suffix } })).resolves.toBe(1);
  });

  it('stores a command result atomically and replays it without repeating effects', async () => {
    const key = randomUUID();
    let executions = 0;
    const input = { userId, scope: 'goal3-command', key, request: { operation: 'create', value: 7 } };
    const command = async (tx: Parameters<Parameters<typeof executeIdempotentCommand>[1]>[0]) => {
      executions += 1;
      await tx.notification.create({ data: { userId, type: 'GOAL3', title: 'Effect', message: key } });
      return { responseCode: 201, responseBody: { accepted: true }, resourceType: 'Notification', resourceId: key };
    };
    await expect(executeIdempotentCommand(input, command)).resolves.toMatchObject({ responseCode: 201, replayed: false });
    await expect(executeIdempotentCommand(input, command)).resolves.toMatchObject({ responseCode: 201, replayed: true });
    expect(executions).toBe(1);
    await expect(prisma.notification.count({ where: { userId, message: key } })).resolves.toBe(1);
  });

  it('scopes command keys by tenant and reuses expired records', async () => {
    const scope = 'goal3-tenant-expiry';
    const key = randomUUID();
    const request = { operation: 'shared' };
    const command = async () => ({ responseCode: 200, responseBody: { ok: true } });
    const [first, second] = await Promise.all([
      executeIdempotentCommand({ userId, scope, key, request }, command),
      executeIdempotentCommand({ userId: otherUserId, scope, key, request }, command),
    ]);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);

    await prisma.idempotencyRecord.updateMany({ where: { userId, scope, key }, data: { expiresAt: new Date(0) } });
    await expect(executeIdempotentCommand({ userId, scope, key, request: { operation: 'replacement' } }, command))
      .resolves.toMatchObject({ replayed: false });
    await expect(prisma.idempotencyRecord.count({ where: { userId, scope, key } })).resolves.toBe(1);
  });

  it('rejects hash conflicts and rolls back records and side effects on failure', async () => {
    const conflictKey = randomUUID();
    await executeIdempotentCommand({ userId, scope: 'goal3-conflict', key: conflictKey, request: { value: 1 } }, async () => ({ responseCode: 200, responseBody: { ok: true } }));
    await expect(executeIdempotentCommand({ userId, scope: 'goal3-conflict', key: conflictKey, request: { value: 2 } }, async () => ({ responseCode: 200, responseBody: { ok: false } })))
      .rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });

    const rollbackKey = randomUUID();
    await expect(executeIdempotentCommand({ userId, scope: 'goal3-rollback', key: rollbackKey, request: { value: 1 } }, async (tx) => {
      await tx.notification.create({ data: { userId, type: 'GOAL3', title: 'Rollback', message: rollbackKey } });
      throw new Error('rollback command');
    })).rejects.toThrow('rollback command');
    await expect(prisma.idempotencyRecord.count({ where: { scope: 'goal3-rollback', key: rollbackKey } })).resolves.toBe(0);
    await expect(prisma.notification.count({ where: { userId, message: rollbackKey } })).resolves.toBe(0);
  });
});
