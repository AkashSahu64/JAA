import { ApplicationStatus, Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { canTransition, transitionApplicationInTenant } from './application-state-machine';

const verificationTypes = new Set(['CAPTCHA', 'MFA', 'ANTI_BOT', 'AUTH']);
const pendingStatus = 'PENDING';
const resolvedStatus = 'RESOLVED';
const expiredStatus = 'EXPIRED';
const cancelledStatus = 'CANCELLED';

function resumeStatusFor(applicationStatus: string): ApplicationStatus {
  return applicationStatus === 'READY_TO_SUBMIT'
    ? ApplicationStatus.READY_TO_SUBMIT
    : ApplicationStatus.FORM_FILLED;
}

export class HumanVerificationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED', message: string) {
    super(message);
    this.name = 'HumanVerificationError';
  }
}

export interface RequestHumanVerificationInput {
  userId: string;
  applicationId: string;
  type: string;
  prompt: string;
  context?: Prisma.InputJsonValue;
  expiresAt: Date;
  correlationId: string;
  idempotencyKey: string;
}

export interface ResolveHumanVerificationInput {
  userId: string;
  verificationId: string;
  correlationId: string;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new HumanVerificationError('INVALID', `${name} is required`);
}

function validExpiry(expiresAt: Date, now: Date): boolean {
  return Number.isFinite(expiresAt.getTime()) && expiresAt > now
    && expiresAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000;
}

function sameRequest(
  verification: { applicationId: string; type: string; prompt: string; context: Prisma.JsonValue | null; expiresAt: Date; correlationId: string },
  input: RequestHumanVerificationInput,
): boolean {
  return verification.applicationId === input.applicationId && verification.type === input.type
    && verification.prompt === input.prompt
    && JSON.stringify(verification.context) === JSON.stringify(input.context ?? null)
    && verification.expiresAt.getTime() === input.expiresAt.getTime()
    && verification.correlationId === input.correlationId;
}

function resumeJobKey(userId: string, verificationId: string): string {
  return `resume-after-human-verification:${userId}:${verificationId}`;
}

export async function requestHumanVerification(input: RequestHumanVerificationInput) {
  requireText(input.userId, 'userId');
  requireText(input.applicationId, 'applicationId');
  requireText(input.type, 'type');
  requireText(input.prompt, 'prompt');
  requireText(input.correlationId, 'correlationId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  if (!verificationTypes.has(input.type)) throw new HumanVerificationError('INVALID', 'Verification type is not supported');
  if (input.prompt.length > 2_000) throw new HumanVerificationError('INVALID', 'Verification prompt is too long');
  const now = new Date();
  if (!validExpiry(input.expiresAt, now)) throw new HumanVerificationError('INVALID', 'Verification expiry must be within the next 24 hours');

  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:${input.idempotencyKey}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:application:${input.applicationId}`}, 0))`;
    const existing = await tx.humanVerification.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (!sameRequest(existing, input)) throw new HumanVerificationError('CONFLICT', 'Idempotency key was already used for a different verification request');
      return { verification: existing, replayed: true as const };
    }
    await tx.humanVerification.updateMany({
      where: { userId: input.userId, applicationId: input.applicationId, status: pendingStatus, expiresAt: { lte: now } },
      data: { status: expiredStatus, resolvedAt: now, resolution: { expiredAt: now.toISOString(), credentialMaterialStored: false } },
    });
    const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
    if (!application) throw new HumanVerificationError('NOT_FOUND', 'Application not found');
    if (!['APPLICATION_STARTED', 'FORM_FILLED', 'READY_TO_SUBMIT', 'WAITING_FOR_USER'].includes(application.status)) {
      throw new HumanVerificationError('CONFLICT', 'Application is not at a human-verification checkpoint');
    }
    const pending = await tx.humanVerification.findFirst({ where: { userId: input.userId, applicationId: input.applicationId, status: pendingStatus } });
    if (pending) throw new HumanVerificationError('CONFLICT', 'Application already has a pending human verification');
    const verification = await tx.humanVerification.create({ data: {
      userId: input.userId, applicationId: application.id, type: input.type, status: pendingStatus,
      prompt: input.prompt, context: input.context, expiresAt: input.expiresAt,
      resumeToStatus: resumeStatusFor(application.status),
      idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    } });
    if (application.status !== 'WAITING_FOR_USER') {
      await transitionApplicationInTenant(tx, {
        applicationId: application.id, userId: input.userId, toStatus: 'WAITING_FOR_USER', expectedVersion: application.version,
        actorType: 'WORKER', reason: `Human verification required: ${input.type}`,
        idempotencyKey: `human-verification-wait:${verification.id}`, correlationId: input.correlationId,
        metadata: { verificationId: verification.id, type: input.type, expiresAt: input.expiresAt.toISOString() },
      });
    }
    await Promise.all([
      tx.auditLog.create({ data: { userId: input.userId, action: 'HUMAN_VERIFICATION_REQUESTED', resource: 'HumanVerification', resourceId: verification.id, details: { applicationId: application.id, type: input.type, expiresAt: input.expiresAt.toISOString() } } }),
      tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'HumanVerification', aggregateId: verification.id, eventType: 'human-verification.requested', payload: { applicationId: application.id, type: input.type, expiresAt: input.expiresAt.toISOString() }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `human-verification-requested:${verification.id}` } }),
    ]);
    return { verification, replayed: false as const };
  });
}

export async function resolveHumanVerification(input: ResolveHumanVerificationInput) {
  requireText(input.userId, 'userId');
  requireText(input.verificationId, 'verificationId');
  requireText(input.correlationId, 'correlationId');
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:resolve:${input.verificationId}`}, 0))`;
    const verification = await tx.humanVerification.findFirst({ where: { id: input.verificationId, userId: input.userId } });
    if (!verification) throw new HumanVerificationError('NOT_FOUND', 'Human verification not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:application:${verification.applicationId}`}, 0))`;
    const resumeKey = resumeJobKey(input.userId, verification.id);
    if (verification.status === resolvedStatus) {
      const resumeJob = await tx.automationJob.findFirst({ where: { userId: input.userId, idempotencyKey: resumeKey } });
      if (!resumeJob) throw new HumanVerificationError('CONFLICT', 'Resolved verification has no resume command');
      return { verification, resumeJob, replayed: true as const };
    }
    if (verification.status !== pendingStatus) throw new HumanVerificationError('CONFLICT', 'Human verification cannot be resolved');
    const now = new Date();
    if (verification.expiresAt <= now) {
      await tx.humanVerification.update({ where: { id: verification.id }, data: { status: expiredStatus, resolvedAt: now, resolution: { expiredAt: now.toISOString(), credentialMaterialStored: false } } });
      throw new HumanVerificationError('EXPIRED', 'Human verification has expired');
    }
    const updated = await tx.humanVerification.update({ where: { id: verification.id }, data: { status: resolvedStatus, resolvedAt: now, resolution: { acknowledgedAt: now.toISOString(), credentialMaterialStored: false } } });
    const resumeJob = await tx.automationJob.create({ data: {
      userId: input.userId, applicationId: verification.applicationId, type: 'RESUME_APPLICATION_AFTER_VERIFICATION', status: 'AVAILABLE',
      payload: { verificationId: verification.id }, payloadVersion: 1, maxAttempts: 3, correlationId: input.correlationId, idempotencyKey: resumeKey,
    } });
    await Promise.all([
      tx.auditLog.create({ data: { userId: input.userId, action: 'HUMAN_VERIFICATION_RESOLVED', resource: 'HumanVerification', resourceId: verification.id, details: { applicationId: verification.applicationId, resumeAutomationJobId: resumeJob.id } } }),
      tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'HumanVerification', aggregateId: verification.id, eventType: 'human-verification.resolved', payload: { applicationId: verification.applicationId, resumeAutomationJobId: resumeJob.id }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `human-verification-resolved:${verification.id}` } }),
    ]);
    return { verification: updated, resumeJob, replayed: false as const };
  });
}

export async function cancelHumanVerification(input: ResolveHumanVerificationInput) {
  requireText(input.userId, 'userId');
  requireText(input.verificationId, 'verificationId');
  requireText(input.correlationId, 'correlationId');
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:cancel:${input.verificationId}`}, 0))`;
    const verification = await tx.humanVerification.findFirst({ where: { id: input.verificationId, userId: input.userId }, include: { application: true } });
    if (!verification) throw new HumanVerificationError('NOT_FOUND', 'Human verification not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:human-verification:application:${verification.applicationId}`}, 0))`;
    if (verification.status === cancelledStatus) return { verification, replayed: true as const };
    if (verification.status !== pendingStatus) throw new HumanVerificationError('CONFLICT', 'Human verification cannot be cancelled');
    const updated = await tx.humanVerification.update({ where: { id: verification.id }, data: { status: cancelledStatus, resolvedAt: new Date(), resolution: { cancelledByUser: true, credentialMaterialStored: false } } });
    if (verification.application.status === 'WAITING_FOR_USER') {
      await transitionApplicationInTenant(tx, { applicationId: verification.applicationId, userId: input.userId, toStatus: 'WITHDRAWN', expectedVersion: verification.application.version, actorType: 'USER', actorId: input.userId, reason: 'User cancelled required human verification', idempotencyKey: `human-verification-cancel:${verification.id}`, correlationId: input.correlationId, metadata: { verificationId: verification.id } });
    }
    await Promise.all([
      tx.auditLog.create({ data: { userId: input.userId, action: 'HUMAN_VERIFICATION_CANCELLED', resource: 'HumanVerification', resourceId: verification.id, details: { applicationId: verification.applicationId } } }),
      tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'HumanVerification', aggregateId: verification.id, eventType: 'human-verification.cancelled', payload: { applicationId: verification.applicationId }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `human-verification-cancelled:${verification.id}` } }),
    ]);
    return { verification: updated, replayed: false as const };
  });
}

export async function resumeHumanVerification(userId: string, verificationId: string, correlationId: string) {
  return withTenant(userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:human-verification:resume:${verificationId}`}, 0))`;
    const verification = await tx.humanVerification.findFirst({ where: { id: verificationId, userId }, include: { application: true } });
    if (!verification) throw new HumanVerificationError('NOT_FOUND', 'Human verification not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:human-verification:application:${verification.applicationId}`}, 0))`;
    if (verification.status !== resolvedStatus) throw new HumanVerificationError('CONFLICT', 'Human verification has not been resolved');
    if (!['FORM_FILLED', 'READY_TO_SUBMIT'].includes(verification.resumeToStatus)
      || !canTransition('WAITING_FOR_USER', verification.resumeToStatus)) {
      throw new HumanVerificationError('CONFLICT', 'Human verification has an unsafe resume target');
    }
    if (verification.application.status !== 'WAITING_FOR_USER') return { resumed: false as const };
    await transitionApplicationInTenant(tx, { applicationId: verification.applicationId, userId, toStatus: verification.resumeToStatus, expectedVersion: verification.application.version, actorType: 'WORKER', reason: 'Human verification was acknowledged; resuming at the safe handoff point', idempotencyKey: `human-verification-resume:${verification.id}`, correlationId, metadata: { verificationId: verification.id, credentialMaterialStored: false } });
    return { resumed: true as const };
  });
}
