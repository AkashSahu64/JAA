import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NotificationType } from '@jobagent/types';
import { consumeOutboxEvent } from './outbox-consumer';
import type { OutboxEnvelope } from './outbox-publisher';

const CONSUMER_NAME = 'tenant-notifications-v1';

interface TransitionPayload {
  fromStatus: string;
  toStatus: string;
  version: number;
}

export interface NotificationMapping {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data: Prisma.InputJsonObject;
}

interface NotificationCopy {
  type: NotificationType;
  title: string;
  message: string;
}

const transitionNotifications: Readonly<Record<string, NotificationCopy>> = {
  WAITING_FOR_USER: {
    type: NotificationType.USER_APPROVAL_REQUIRED,
    title: 'Action required',
    message: 'This application is waiting for your input before it can continue.',
  },
  CONFIRMED: {
    type: NotificationType.APPLICATION_SUBMITTED,
    title: 'Application confirmed',
    message: 'Your application was independently confirmed as submitted.',
  },
  ASSESSMENT: {
    type: NotificationType.ASSESSMENT_DETECTED,
    title: 'Assessment detected',
    message: 'An assessment was recorded for this application.',
  },
  UNCONFIRMED: {
    type: NotificationType.SUBMISSION_UNCERTAIN,
    title: 'Submission needs verification',
    message: 'Submission was attempted, but independent confirmation is still required.',
  },
  READY_TO_SUBMIT: {
    type: NotificationType.APPLICATION_READY,
    title: 'Application ready',
    message: 'An application passed review and is ready for your explicit submission authorization.',
  },
  FAILED: {
    type: NotificationType.APPLICATION_FAILED,
    title: 'Application needs attention',
    message: 'Application processing failed. Review the application for details and next steps.',
  },
  REJECTED: {
    type: NotificationType.APPLICATION_REJECTED,
    title: 'Application update',
    message: 'This application was marked as rejected. Review the application for details.',
  },
  WITHDRAWN: {
    type: NotificationType.APPLICATION_WITHDRAWN,
    title: 'Application withdrawn',
    message: 'This application was withdrawn and will not continue through the application workflow.',
  },
  INTERVIEW: {
    type: NotificationType.INTERVIEW_DETECTED,
    title: 'Interview detected',
    message: 'An interview was recorded for this application.',
  },
  OFFER: {
    type: NotificationType.OFFER_DETECTED,
    title: 'Offer detected',
    message: 'An offer was recorded for this application.',
  },
};

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function isObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transitionPayload(value: Prisma.JsonValue): TransitionPayload | null {
  if (!isObject(value)) return null;
  const { fromStatus, toStatus, version } = value;
  if (typeof fromStatus !== 'string' || typeof toStatus !== 'string'
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;
  return { fromStatus, toStatus, version };
}

function deterministicNotificationId(event: OutboxEnvelope, type: NotificationType): string {
  const hex = createHash('sha256')
    .update(`${CONSUMER_NAME}\0${event.userId}\0${event.idempotencyKey}\0${type}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validEnvelopeBoundary(event: OutboxEnvelope): boolean {
  const boundedText = (value: unknown, max: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
  return boundedText(event.id, 200) && !hasControlCharacters(event.id)
    && (event.userId === null || boundedText(event.userId, 200))
    && (event.userId === null || !hasControlCharacters(event.userId))
    && boundedText(event.aggregateType, 100) && !hasControlCharacters(event.aggregateType)
    && boundedText(event.aggregateId, 200) && !hasControlCharacters(event.aggregateId)
    && boundedText(event.eventType, 200) && !hasControlCharacters(event.eventType)
    && boundedText(event.correlationId, 200) && !hasControlCharacters(event.correlationId)
    && boundedText(event.idempotencyKey, 300) && !hasControlCharacters(event.idempotencyKey)
    && event.schemaVersion === 1
    && event.occurredAt instanceof Date
    && Number.isFinite(event.occurredAt.getTime());
}

function boundedPayloadText(value: unknown, max = 200): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !hasControlCharacters(value);
}

function operationalAlertPayload(value: Prisma.JsonValue): { code: string; severity: string; message: string; value: number; threshold: number } | null {
  if (!isObject(value) || !boundedPayloadText(value.code, 80) || !boundedPayloadText(value.severity, 20)
    || !boundedPayloadText(value.message, 500) || typeof value.value !== 'number' || !Number.isFinite(value.value)
    || typeof value.threshold !== 'number' || !Number.isFinite(value.threshold)) return null;
  return { code: value.code, severity: value.severity, message: value.message, value: value.value, threshold: value.threshold };
}

export function mapOutboxEventToNotification(event: OutboxEnvelope): NotificationMapping | null {
  if (!validEnvelopeBoundary(event) || !event.userId) return null;
  if (event.aggregateType === 'JobDiscoveryRun' && event.eventType === 'job.discovery.completed') {
    if (!isObject(event.payload) || typeof event.payload.jobsCreated !== 'number' || typeof event.payload.jobsUpdated !== 'number'
      || !Number.isSafeInteger(event.payload.jobsCreated) || !Number.isSafeInteger(event.payload.jobsUpdated)
      || event.payload.jobsCreated < 0 || event.payload.jobsUpdated < 0
      || event.payload.jobsCreated + event.payload.jobsUpdated < 1) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.JOB_DISCOVERED), userId: event.userId,
      type: NotificationType.JOB_DISCOVERED, title: 'Jobs discovered',
      message: 'New jobs were discovered and are ready for matching.',
      data: { outboxEventId: event.id, correlationId: event.correlationId, discoveryRunId: event.aggregateId, jobsCreated: event.payload.jobsCreated, jobsUpdated: event.payload.jobsUpdated },
    };
  }
  if (event.aggregateType === 'EmailOutcome' && event.eventType === 'email.outcome.detected') {
    if (!isObject(event.payload) || !boundedPayloadText(event.payload.classification) || !boundedPayloadText(event.payload.confidence)
      || (event.payload.applicationId !== null && event.payload.applicationId !== undefined && !boundedPayloadText(event.payload.applicationId))) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.EMAIL_OUTCOME_DETECTED), userId: event.userId,
      type: NotificationType.EMAIL_OUTCOME_DETECTED, title: 'Email outcome detected',
      message: 'A new application-related email outcome is ready for review.',
      data: { outboxEventId: event.id, correlationId: event.correlationId, emailOutcomeId: event.aggregateId, applicationId: typeof event.payload.applicationId === 'string' ? event.payload.applicationId : null, classification: event.payload.classification, confidence: event.payload.confidence },
    };
  }
  if (event.aggregateType === 'HumanVerification' && event.eventType === 'human-verification.requested') {
    if (!isObject(event.payload) || !boundedPayloadText(event.payload.applicationId) || !boundedPayloadText(event.payload.type)) return null;
    const hasVerificationId = Object.prototype.hasOwnProperty.call(event.payload, 'verificationId');
    if (hasVerificationId && !boundedPayloadText(event.payload.verificationId)) return null;
    const verificationId = hasVerificationId ? event.payload.verificationId : event.aggregateId;
    const type = event.payload.type === 'CAPTCHA' ? NotificationType.CAPTCHA_REQUIRED
      : event.payload.type === 'MFA' ? NotificationType.MFA_REQUIRED : NotificationType.HUMAN_VERIFICATION_REQUIRED;
    return {
      id: deterministicNotificationId(event, type), userId: event.userId, type,
      title: 'Human verification required', message: 'Complete the requested verification in the provider application before automation can continue.',
      data: { outboxEventId: event.id, correlationId: event.correlationId, applicationId: event.payload.applicationId, verificationId, verificationType: event.payload.type },
    };
  }
  if (event.aggregateType === 'Application' && event.eventType === 'application.run.scheduled') {
    if (!isObject(event.payload) || !boundedPayloadText(event.payload.applicationId) || !boundedPayloadText(event.payload.automationJobId)
      || !boundedPayloadText(event.payload.provider) || !boundedPayloadText(event.payload.runAt)) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.APPLICATION_SCHEDULED), userId: event.userId,
      type: NotificationType.APPLICATION_SCHEDULED, title: 'Application run scheduled',
      message: 'The provider form run was scheduled and is waiting for its durable execution slot.',
      data: { outboxEventId: event.id, correlationId: event.correlationId, applicationId: event.payload.applicationId, automationJobId: event.payload.automationJobId, provider: event.payload.provider, runAt: event.payload.runAt },
    };
  }
  if (event.aggregateType === 'SubmissionAuthorization' && event.eventType === 'submission.outcome.unknown') {
    if (!isObject(event.payload) || !boundedPayloadText(event.payload.applicationId)) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.SUBMISSION_UNCERTAIN), userId: event.userId,
      type: NotificationType.SUBMISSION_UNCERTAIN,
      title: 'Submission needs verification',
      message: 'Submission outcome is unknown; independent confirmation is still required and automatic retry is blocked.',
      data: { outboxEventId: event.id, correlationId: event.correlationId, applicationId: event.payload.applicationId, authorizationId: event.aggregateId, eventType: event.eventType },
    };
  }
  if (event.aggregateType === 'AutomationOperations' && event.eventType === 'automation.alert') {
    const payload = operationalAlertPayload(event.payload);
    if (!payload) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.OPERATIONAL_ALERT), userId: event.userId,
      type: NotificationType.OPERATIONAL_ALERT, title: `Automation alert: ${payload.code}`,
      message: payload.message,
      data: { outboxEventId: event.id, correlationId: event.correlationId, code: payload.code, severity: payload.severity, value: payload.value, threshold: payload.threshold },
    };
  }
  if (event.aggregateType === 'Application' && event.eventType === 'application.review-required') {
    if (!isObject(event.payload) || !boundedPayloadText(event.payload.provider)
      || !Array.isArray(event.payload.requiredBlockingFieldIds) || !Array.isArray(event.payload.validationErrors)) return null;
    return {
      id: deterministicNotificationId(event, NotificationType.USER_APPROVAL_REQUIRED), userId: event.userId,
      type: NotificationType.USER_APPROVAL_REQUIRED, title: 'Application review required',
      message: 'Review the application fields and resolve the reported issues before automation can continue.',
      data: {
        outboxEventId: event.id, correlationId: event.correlationId, applicationId: event.aggregateId,
        provider: event.payload.provider, blockingFieldCount: event.payload.requiredBlockingFieldIds.length,
        validationErrorCount: event.payload.validationErrors.length,
      },
    };
  }
  if (event.aggregateType !== 'Application' || event.eventType !== 'application.status.transitioned') return null;
  const payload = transitionPayload(event.payload);
  if (!payload) return null;
  const copy = transitionNotifications[payload.toStatus];
  if (!copy) return null;
  return {
    id: deterministicNotificationId(event, copy.type),
    userId: event.userId,
    ...copy,
    data: {
      outboxEventId: event.id,
      correlationId: event.correlationId,
      applicationId: event.aggregateId,
      eventType: event.eventType,
      fromStatus: payload.fromStatus,
      toStatus: payload.toStatus,
      version: payload.version,
    },
  };
}

export async function consumeNotificationOutboxEvent(event: OutboxEnvelope) {
  return consumeOutboxEvent({
    consumer: CONSUMER_NAME,
    event,
    handle: async (tx, deliveredEvent) => {
      const notification = mapOutboxEventToNotification(deliveredEvent);
      if (!notification) {
        return { responseCode: 204, responseBody: { consumed: false, reason: 'unsupported_event' } };
      }
      await tx.notification.upsert({
        where: { id: notification.id },
        create: notification,
        update: {},
      });
      return {
        responseCode: 201,
        responseBody: { consumed: true, notificationId: notification.id },
        resourceType: 'Notification',
        resourceId: notification.id,
      };
    },
  });
}
