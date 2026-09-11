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
  FAILED: {
    type: NotificationType.APPLICATION_FAILED,
    title: 'Application needs attention',
    message: 'Application processing failed. Review the application for details and next steps.',
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

export function mapOutboxEventToNotification(event: OutboxEnvelope): NotificationMapping | null {
  if (!event.userId || event.schemaVersion !== 1 || event.aggregateType !== 'Application'
    || event.eventType !== 'application.status.transitioned') return null;
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
