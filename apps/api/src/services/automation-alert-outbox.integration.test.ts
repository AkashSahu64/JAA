import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { persistAutomationAlerts } from './automation-alert-outbox';
import { consumeNotificationOutboxEvent } from './notification-outbox-consumer';
import type { OutboxEnvelope } from './outbox-publisher';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable operational alert delivery', () => {
  const userId = randomUUID();
  const now = new Date('2026-09-16T00:00:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Alert Fixture' } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('deduplicates an alert window and delivers it through the notification consumer', async () => {
    const alert = { code: 'QUEUE_FAILURES' as const, severity: 'CRITICAL' as const, message: 'Queue contains failed work', value: 2, threshold: 1 };
    await persistAutomationAlerts(userId, [alert], 'alert-correlation', now);
    await persistAutomationAlerts(userId, [alert], 'alert-correlation-replay', now);
    const events = await prisma.outboxEvent.findMany({ where: { userId, eventType: 'automation.alert' } });
    expect(events).toHaveLength(1);
    const consumed = await consumeNotificationOutboxEvent(events[0] as OutboxEnvelope);
    expect(consumed).toMatchObject({ responseCode: 201, responseBody: { consumed: true } });
    await expect(prisma.notification.findFirstOrThrow({ where: { userId } })).resolves.toMatchObject({ type: 'OPERATIONAL_ALERT', title: 'Automation alert: QUEUE_FAILURES', read: false });
  });
});
