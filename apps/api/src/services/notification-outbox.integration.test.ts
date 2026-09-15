import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { consumeNotificationOutboxEvent } from './notification-outbox-consumer';
import type { OutboxEnvelope } from './outbox-publisher';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable notification outbox delivery', () => {
  const userId = randomUUID();
  const eventId = randomUUID();
  const idempotencyKey = `notification-fixture:${randomUUID()}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Notification Fixture' } });
    await prisma.outboxEvent.create({ data: {
      id: eventId, userId, aggregateType: 'Application', aggregateId: 'application-fixture',
      eventType: 'application.status.transitioned', payload: { fromStatus: 'READY_TO_SUBMIT', toStatus: 'CONFIRMED', version: 4 },
      schemaVersion: 1, correlationId: 'notification-correlation', idempotencyKey,
    } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('persists one tenant-owned notification and replays duplicate delivery safely', async () => {
    const stored = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    const event: OutboxEnvelope = {
      ...stored,
      userId: stored.userId!,
      payload: stored.payload,
      publishAttempts: stored.publishAttempts,
    };
    const first = await consumeNotificationOutboxEvent(event);
    const replay = await consumeNotificationOutboxEvent(event);
    expect(first).toMatchObject({ responseCode: 201, replayed: false, responseBody: { consumed: true } });
    expect(replay).toMatchObject({ responseCode: 201, replayed: true, responseBody: { consumed: true } });
    await expect(prisma.notification.findMany({ where: { userId } }))
      .resolves.toHaveLength(1);
    await expect(prisma.notification.findFirstOrThrow({ where: { userId } }))
      .resolves.toMatchObject({ type: 'APPLICATION_SUBMITTED', title: 'Application confirmed' });
  });
});
