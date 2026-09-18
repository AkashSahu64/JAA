import { ApplicationStatus, Prisma } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@jobagent/database';

const transitions: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DISCOVERED: ['QUALIFIED', 'SKIPPED'],
  QUALIFIED: ['RESUME_GENERATED', 'SKIPPED', 'FAILED'],
  SKIPPED: [],
  RESUME_GENERATED: ['RESUME_VALIDATED', 'FAILED'],
  RESUME_VALIDATED: ['ATS_VALIDATED', 'FAILED'],
  ATS_VALIDATED: ['QUEUED', 'SKIPPED', 'FAILED'],
  QUEUED: ['APPLICATION_STARTED', 'RETRY_PENDING', 'FAILED', 'WITHDRAWN'],
  APPLICATION_STARTED: ['FORM_FILLED', 'WAITING_FOR_USER', 'RETRY_PENDING', 'FAILED', 'WITHDRAWN'],
  FORM_FILLED: ['WAITING_FOR_USER', 'READY_TO_SUBMIT', 'RETRY_PENDING', 'FAILED', 'WITHDRAWN'],
  WAITING_FOR_USER: ['FORM_FILLED', 'READY_TO_SUBMIT', 'FAILED', 'WITHDRAWN'],
  READY_TO_SUBMIT: ['SUBMISSION_PENDING', 'WAITING_FOR_USER', 'FAILED', 'WITHDRAWN'],
  // An explicit authorization can expire before the worker claims it. In that
  // case no provider side effect occurred, so the application may safely
  // return to the authorization gate for a fresh owner decision.
  SUBMISSION_PENDING: ['READY_TO_SUBMIT', 'WAITING_FOR_USER', 'UNCONFIRMED', 'RETRY_PENDING', 'FAILED'],
  SUBMITTED: ['UNCONFIRMED'],
  UNCONFIRMED: ['CONFIRMED', 'RETRY_PENDING', 'FAILED'],
  CONFIRMED: ['ASSESSMENT', 'INTERVIEW', 'REJECTED', 'OFFER', 'WITHDRAWN'],
  ASSESSMENT: ['INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  FAILED: ['RETRY_PENDING', 'WITHDRAWN'],
  RETRY_PENDING: ['QUEUED', 'APPLICATION_STARTED', 'FAILED', 'WITHDRAWN'],
  INTERVIEW: ['INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  OFFER: ['ACCEPTED', 'REJECTED', 'WITHDRAWN'],
  ACCEPTED: [],
  WITHDRAWN: [],
};

export type TransitionActor = 'USER' | 'SYSTEM' | 'WORKER' | 'VERIFIER';

export interface TransitionApplicationInput {
  applicationId: string;
  userId: string;
  toStatus: ApplicationStatus;
  expectedVersion: number;
  actorType: TransitionActor;
  actorId?: string;
  reason: string;
  idempotencyKey: string;
  correlationId: string;
  metadata?: Prisma.InputJsonObject;
  /** Source event time when a transition represents an externally observed action. */
  effectiveAt?: Date;
}

export class ApplicationTransitionError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'STALE_VERSION' | 'IDEMPOTENCY_CONFLICT' | 'VERIFICATION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationTransitionError';
  }
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return transitions[from].includes(to);
}

export function allowedTransitions(from: ApplicationStatus): readonly ApplicationStatus[] {
  return transitions[from];
}

function validateInput(input: TransitionApplicationInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ApplicationTransitionError('STALE_VERSION', 'expectedVersion must be a positive integer');
  }
  if (!input.reason.trim()) throw new ApplicationTransitionError('INVALID_TRANSITION', 'A transition reason is required');
  if (!input.idempotencyKey.trim()) throw new ApplicationTransitionError('IDEMPOTENCY_CONFLICT', 'An idempotency key is required');
  if (!input.correlationId.trim()) throw new ApplicationTransitionError('INVALID_TRANSITION', 'A correlation ID is required');
  if (input.effectiveAt !== undefined && (!(input.effectiveAt instanceof Date) || !Number.isFinite(input.effectiveAt.getTime()))) {
    throw new ApplicationTransitionError('INVALID_TRANSITION', 'The transition effective time is invalid');
  }
  if (input.toStatus === 'CONFIRMED' && input.actorType !== 'VERIFIER') {
    throw new ApplicationTransitionError('VERIFICATION_REQUIRED', 'CONFIRMED requires the independent verifier');
  }
}

/** Compare JSON metadata by value, not by the insertion order of object keys. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

async function findReplay(tx: TenantTransaction, input: TransitionApplicationInput) {
  const transition = await tx.applicationStatusTransition.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
  if (!transition) return null;
  if (transition.applicationId !== input.applicationId
    || transition.userId !== input.userId
    || transition.toStatus !== input.toStatus
    || transition.version !== input.expectedVersion + 1
    || transition.actorType !== input.actorType
    || transition.actorId !== (input.actorId ?? null)
    || transition.reason !== input.reason
    || transition.correlationId !== input.correlationId
    || canonicalJson(transition.metadata) !== canonicalJson(input.metadata ?? null)) {
    throw new ApplicationTransitionError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different transition');
  }
  const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
  if (!application) throw new ApplicationTransitionError('NOT_FOUND', 'Application not found');
  return { application, transition, replayed: true as const };
}

export async function transitionApplicationInTenant(tx: TenantTransaction, input: TransitionApplicationInput) {
  validateInput(input);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.idempotencyKey}`}, 0))`;
  const replay = await findReplay(tx, input);
  if (replay) return replay;
  const current = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
  if (!current) throw new ApplicationTransitionError('NOT_FOUND', 'Application not found');
  if (current.version !== input.expectedVersion) throw new ApplicationTransitionError('STALE_VERSION', 'Application version is stale');
  if (!canTransition(current.status, input.toStatus)) {
    throw new ApplicationTransitionError('INVALID_TRANSITION', `Cannot transition from ${current.status} to ${input.toStatus}`);
  }
  const now = input.effectiveAt ?? new Date();
  const changed = await tx.application.updateMany({
    where: { id: current.id, userId: input.userId, status: current.status, version: input.expectedVersion },
    data: {
      status: input.toStatus,
      version: { increment: 1 },
      ...(input.toStatus === 'UNCONFIRMED' ? { appliedAt: now } : {}),
      ...(input.toStatus === 'CONFIRMED' ? { confirmedAt: now } : {}),
      ...(input.toStatus === 'FAILED' ? { failedAt: now, failureReason: input.reason } : {}),
    },
  });
  if (changed.count !== 1) throw new ApplicationTransitionError('STALE_VERSION', 'Application changed concurrently');
  const transition = await tx.applicationStatusTransition.create({
    data: { applicationId: current.id, userId: input.userId, fromStatus: current.status, toStatus: input.toStatus, actorType: input.actorType, actorId: input.actorId, reason: input.reason, metadata: input.metadata, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, version: input.expectedVersion + 1 },
  });
  await Promise.all([
    tx.auditLog.create({ data: { userId: input.userId, action: 'APPLICATION_STATUS_TRANSITIONED', resource: 'Application', resourceId: current.id, details: { fromStatus: current.status, toStatus: input.toStatus, actorType: input.actorType, reason: input.reason, correlationId: input.correlationId } } }),
    tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'Application', aggregateId: current.id, eventType: 'application.status.transitioned', payload: { fromStatus: current.status, toStatus: input.toStatus, version: input.expectedVersion + 1, actorType: input.actorType, reason: input.reason }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `application-transition:${input.userId}:${input.idempotencyKey}` } }),
  ]);
  const application = await tx.application.findUniqueOrThrow({ where: { id: current.id } });
  return { application, transition, replayed: false as const };
}

export async function transitionApplication(input: TransitionApplicationInput) {
  return withTenant(input.userId, tx => transitionApplicationInTenant(tx, input));
}
