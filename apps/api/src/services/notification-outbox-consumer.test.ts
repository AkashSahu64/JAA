import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEnvelope } from './outbox-publisher';

const mocks = vi.hoisted(() => ({
  consumeOutboxEvent: vi.fn(),
  notificationUpsert: vi.fn(),
}));

vi.mock('./outbox-consumer', () => ({
  consumeOutboxEvent: mocks.consumeOutboxEvent,
}));

import {
  consumeNotificationOutboxEvent,
  mapOutboxEventToNotification,
} from './notification-outbox-consumer';

function event(overrides: Partial<OutboxEnvelope> = {}): OutboxEnvelope {
  return {
    id: 'event-1',
    userId: 'user-1',
    aggregateType: 'Application',
    aggregateId: 'application-1',
    eventType: 'application.status.transitioned',
    payload: { fromStatus: 'UNCONFIRMED', toStatus: 'CONFIRMED', version: 7 },
    schemaVersion: 1,
    correlationId: 'correlation-1',
    idempotencyKey: 'application-transition:user-1:fixture.invalid',
    occurredAt: new Date('2026-09-08T00:00:00.000Z'),
    publishAttempts: 1,
    ...overrides,
  };
}

describe('notification outbox consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeOutboxEvent.mockImplementation(async (options) => ({
      ...(await options.handle({ notification: { upsert: mocks.notificationUpsert } }, options.event)),
      replayed: false,
    }));
    mocks.notificationUpsert.mockResolvedValue({});
  });

  it.each([
    ['WAITING_FOR_USER', 'USER_APPROVAL_REQUIRED', 'Action required'],
    ['CONFIRMED', 'APPLICATION_SUBMITTED', 'Application confirmed'],
    ['FAILED', 'APPLICATION_FAILED', 'Application needs attention'],
    ['INTERVIEW', 'INTERVIEW_DETECTED', 'Interview detected'],
    ['OFFER', 'OFFER_DETECTED', 'Offer detected'],
  ])('maps %s lifecycle transitions to durable notification data', (toStatus, type, title) => {
    const mapped = mapOutboxEventToNotification(event({
      payload: { fromStatus: 'QUEUED', toStatus, version: 3 },
    }));
    expect(mapped).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      userId: 'user-1',
      type,
      title,
      data: {
        outboxEventId: 'event-1',
        correlationId: 'correlation-1',
        applicationId: 'application-1',
        fromStatus: 'QUEUED',
        toStatus,
        version: 3,
      },
    });
  });

  it('derives stable identity from tenant and event identity', () => {
    const first = mapOutboxEventToNotification(event());
    const duplicateDelivery = mapOutboxEventToNotification(event({ id: 'delivery-copy' }));
    const otherTenant = mapOutboxEventToNotification(event({ userId: 'user-2' }));
    expect(first?.id).toBe(duplicateDelivery?.id);
    expect(otherTenant?.id).not.toBe(first?.id);
  });

  it.each([
    { eventType: 'fixture.unknown' },
    { aggregateType: 'Job' },
    { schemaVersion: 2 },
    { userId: null },
    { payload: { toStatus: 'CONFIRMED', version: 1 } },
    { payload: { fromStatus: 'QUEUED', toStatus: 'READY_TO_SUBMIT', version: 2 } },
  ])('safely ignores unsupported or malformed events %#', (override) => {
    expect(mapOutboxEventToNotification(event(override))).toBeNull();
  });

  it('uses durable outbox idempotency and upserts by deterministic identity', async () => {
    const delivered = event();
    await expect(consumeNotificationOutboxEvent(delivered)).resolves.toMatchObject({
      responseCode: 201,
      responseBody: { consumed: true, notificationId: expect.any(String) },
      replayed: false,
    });
    expect(mocks.consumeOutboxEvent).toHaveBeenCalledWith(expect.objectContaining({
      consumer: 'tenant-notifications-v1',
      event: delivered,
    }));
    expect(mocks.notificationUpsert).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      create: expect.objectContaining({ userId: 'user-1', type: 'APPLICATION_SUBMITTED' }),
      update: {},
    });
  });

  it('acknowledges unknown events without writing fake activity', async () => {
    await expect(consumeNotificationOutboxEvent(event({ eventType: 'fixture.unknown' })))
      .resolves.toMatchObject({
        responseCode: 204,
        responseBody: { consumed: false, reason: 'unsupported_event' },
      });
    expect(mocks.notificationUpsert).not.toHaveBeenCalled();
  });
});
