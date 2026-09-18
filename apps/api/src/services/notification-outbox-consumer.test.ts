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
    ['ASSESSMENT', 'ASSESSMENT_DETECTED', 'Assessment detected'],
    ['FAILED', 'APPLICATION_FAILED', 'Application needs attention'],
    ['REJECTED', 'APPLICATION_REJECTED', 'Application update'],
    ['WITHDRAWN', 'APPLICATION_WITHDRAWN', 'Application withdrawn'],
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

  it('notifies for uncertain submissions and human verification requests', () => {
    expect(mapOutboxEventToNotification(event({ payload: { fromStatus: 'SUBMISSION_PENDING', toStatus: 'UNCONFIRMED', version: 3 } })))
      .toMatchObject({ type: 'SUBMISSION_UNCERTAIN' });
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'SubmissionAuthorization', aggregateId: 'authorization-1', eventType: 'submission.outcome.unknown',
      payload: { applicationId: 'application-1', authorizationId: 'authorization-1', independentlyConfirmed: false },
    }))).toMatchObject({
      type: 'SUBMISSION_UNCERTAIN',
      message: expect.stringContaining('automatic retry is blocked'),
      data: { applicationId: 'application-1', authorizationId: 'authorization-1' },
    });
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'HumanVerification', aggregateId: 'verification-1', eventType: 'human-verification.requested',
      payload: { applicationId: 'application-1', verificationId: 'verification-1', type: 'CAPTCHA' },
    }))).toMatchObject({ type: 'CAPTCHA_REQUIRED', data: { applicationId: 'application-1', verificationId: 'verification-1', verificationType: 'CAPTCHA' } });
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'HumanVerification', aggregateId: 'legacy-verification-1', eventType: 'human-verification.requested',
      payload: { applicationId: 'application-1', type: 'MFA' },
    }))).toMatchObject({ type: 'MFA_REQUIRED', data: { verificationId: 'legacy-verification-1' } });
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'HumanVerification', aggregateId: 'verification-1', eventType: 'human-verification.requested',
      payload: { applicationId: 'application-1', verificationId: ' ', type: 'CAPTCHA' },
    }))).toBeNull();
  });

  it('maps durable discovery completion events to job notifications', () => {
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'JobDiscoveryRun', aggregateId: 'discovery-1', eventType: 'job.discovery.completed',
      payload: { status: 'SUCCEEDED', jobsCreated: 3, jobsUpdated: 1, itemsDuplicate: 2 },
    }))).toMatchObject({
      type: 'JOB_DISCOVERED', title: 'Jobs discovered',
      data: { discoveryRunId: 'discovery-1', jobsCreated: 3, jobsUpdated: 1 },
    });
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'JobDiscoveryRun', eventType: 'job.discovery.completed', payload: { jobsCreated: 0, jobsUpdated: 0 },
    }))).toBeNull();
  });

  it('maps provider review-required events to a durable approval notification', () => {
    expect(mapOutboxEventToNotification(event({
      eventType: 'application.review-required',
      payload: { provider: 'LEVER', step: 2, requiredBlockingFieldIds: ['question-1'], validationErrors: [{ fieldId: 'email', message: 'Invalid email' }] },
    }))).toMatchObject({
      type: 'USER_APPROVAL_REQUIRED', title: 'Application review required',
      data: { applicationId: 'application-1', provider: 'LEVER', blockingFieldCount: 1, validationErrorCount: 1 },
    });
  });

  it('maps scheduled application runs to durable tenant notifications', () => {
    expect(mapOutboxEventToNotification(event({
      eventType: 'application.run.scheduled',
      payload: { applicationId: 'application-1', automationJobId: 'automation-1', provider: 'LEVER', runAt: '2026-09-16T10:00:00.000Z' },
    }))).toMatchObject({
      type: 'APPLICATION_SCHEDULED', title: 'Application run scheduled',
      data: { applicationId: 'application-1', automationJobId: 'automation-1', provider: 'LEVER', runAt: '2026-09-16T10:00:00.000Z' },
    });
    expect(mapOutboxEventToNotification(event({ eventType: 'application.run.scheduled', payload: { applicationId: 'application-1' } }))).toBeNull();
  });

  it('maps operational alerts to durable notification data', () => {
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'AutomationOperations', aggregateId: 'user-1', eventType: 'automation.alert',
      payload: { code: 'QUEUE_FAILURES', severity: 'CRITICAL', message: 'Queue contains failed work', value: 2, threshold: 1 },
    }))).toMatchObject({
      type: 'OPERATIONAL_ALERT', title: 'Automation alert: QUEUE_FAILURES', message: 'Queue contains failed work',
      data: { code: 'QUEUE_FAILURES', severity: 'CRITICAL', value: 2, threshold: 1 },
    });
    expect(mapOutboxEventToNotification(event({ aggregateType: 'AutomationOperations', eventType: 'automation.alert', payload: { code: 'QUEUE_FAILURES' } }))).toBeNull();
  });

  it('maps classified email outcomes to a durable review notification without changing lifecycle state', () => {
    expect(mapOutboxEventToNotification(event({
      aggregateType: 'EmailOutcome', aggregateId: 'email-outcome-1', eventType: 'email.outcome.detected',
      payload: { applicationId: 'application-1', classification: 'INTERVIEW_INVITATION', confidence: 'HIGH' },
    }))).toMatchObject({
      type: 'EMAIL_OUTCOME_DETECTED',
      data: { emailOutcomeId: 'email-outcome-1', applicationId: 'application-1', classification: 'INTERVIEW_INVITATION', confidence: 'HIGH' },
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
    { payload: { fromStatus: 'QUEUED', toStatus: 'APPLICATION_STARTED', version: 2 } },
  ])('safely ignores unsupported or malformed events %#', (override) => {
    expect(mapOutboxEventToNotification(event(override))).toBeNull();
  });

  it.each([
    { aggregateId: 42 as never },
    { correlationId: '' },
    { correlationId: 'correlation\nlog-forgery' },
    { idempotencyKey: 'x'.repeat(301) },
    { occurredAt: 'not-a-date' as never },
    { userId: 42 as never },
  ])('rejects malformed notification envelope identity %#', override => {
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
