import { ApplicationStatus, Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';

interface BaseLifecycleInput { userId: string; applicationId: string; sourceEventId?: string; }
export interface InterviewInput extends BaseLifecycleInput {
  date?: Date; type: string; company: string; role: string; round?: number; interviewer?: string; meetingUrl?: string;
}
export interface OfferInput extends BaseLifecycleInput {
  company: string; role: string; salaryOffered?: number; currency?: string; benefits?: string; startDate?: Date; expiresAt?: Date;
}
export type OfferDecision = 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function validateBaseLifecycleInput(input: BaseLifecycleInput): void {
  if (!input || typeof input.userId !== 'string' || !input.userId.trim() || input.userId.length > 200
    || typeof input.applicationId !== 'string' || !input.applicationId.trim() || input.applicationId.length > 200
    || hasControlCharacters(input.userId) || hasControlCharacters(input.applicationId)
    || (input.sourceEventId !== undefined && (typeof input.sourceEventId !== 'string' || !input.sourceEventId.trim() || input.sourceEventId.length > 200 || hasControlCharacters(input.sourceEventId)))) {
    throw new Error('Lifecycle identity is required and bounded');
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function required(value: string, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} is required and bounded`);
  if (hasControlCharacters(value)) throw new Error(`${name} is required and bounded`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error(`${name} is required and bounded`);
  return normalized;
}

function optionalText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Optional lifecycle text is invalid');
  if (hasControlCharacters(value)) throw new Error('Optional lifecycle text is invalid');
  const normalized = value.trim();
  if (normalized.length > max) throw new Error('Optional lifecycle text is invalid');
  return normalized || undefined;
}

function optionalDate(value: Date | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
}

function httpsUrl(value: string | undefined): string | undefined {
  const normalized = optionalText(value, 2_000);
  if (normalized === undefined) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('invalid');
  } catch {
    throw new Error('Meeting URL must be a valid HTTPS URL');
  }
  return normalized;
}

function sameDate(left: Date | null | undefined, right: Date | undefined): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

function sameInterviewEvent(existing: any, input: InterviewInput, normalized: { type: string; company: string; role: string; interviewer?: string; meetingUrl?: string; date?: Date; round: number }): boolean {
  return existing.userId === input.userId && existing.applicationId === input.applicationId
    && existing.type === normalized.type && existing.company === normalized.company && existing.role === normalized.role
    && (existing.interviewer ?? undefined) === normalized.interviewer && (existing.meetingUrl ?? undefined) === normalized.meetingUrl
    && existing.round === normalized.round && sameDate(existing.date, normalized.date);
}

function sameOfferEvent(existing: any, input: OfferInput, normalized: { company: string; role: string; salaryOffered?: number; currency?: string; benefits?: string; startDate?: Date; expiresAt?: Date }): boolean {
  return existing.userId === input.userId && existing.applicationId === input.applicationId
    && existing.company === normalized.company && existing.role === normalized.role
    && (existing.salaryOffered ?? undefined) === normalized.salaryOffered
    && (existing.currency ?? undefined) === normalized.currency && (existing.benefits ?? undefined) === normalized.benefits
    && sameDate(existing.startDate, normalized.startDate) && sameDate(existing.expiresAt, normalized.expiresAt);
}

async function ensureStatus(tx: any, input: BaseLifecycleInput, target: ApplicationStatus, reason: string, key: string) {
  const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId }, select: { id: true, status: true, version: true } });
  if (!application) throw new Error('Application does not belong to tenant');
  if (application.status === target) return application;
  if (target === 'INTERVIEW' && application.status !== 'CONFIRMED') throw new Error('Interview requires independently confirmed application');
  await transitionApplicationInTenant(tx, { applicationId: input.applicationId, userId: input.userId, toStatus: target, expectedVersion: application.version, actorType: 'USER', actorId: input.userId, reason, idempotencyKey: key, correlationId: input.applicationId, metadata: { sourceEventId: input.sourceEventId ?? null } });
  return tx.application.findUniqueOrThrow({ where: { id: input.applicationId } });
}

export async function recordInterview(input: InterviewInput) {
  validateBaseLifecycleInput(input);
  const type = required(input.type, 'Interview type');
  const company = required(input.company, 'Company');
  const role = required(input.role, 'Role');
  const interviewer = optionalText(input.interviewer, 500);
  const meetingUrl = httpsUrl(input.meetingUrl);
  const date = optionalDate(input.date, 'Interview date');
  const round = input.round ?? 1;
  if (!Number.isSafeInteger(round) || round < 1 || round > 100) throw new Error('Interview round is invalid');
  const persist = () => withTenant(input.userId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:interview:${input.sourceEventId ?? input.applicationId}`}, 0))`;
    const db = tx as any;
    const existing = input.sourceEventId ? await db.interview.findUnique({ where: { userId_sourceEventId: { userId: input.userId, sourceEventId: input.sourceEventId } } }) : null;
    if (existing) {
      if (!sameInterviewEvent(existing, input, { type, company, role, interviewer, meetingUrl, date, round })) throw new Error('Interview source event conflicts with an existing lifecycle event');
      return existing;
    }
    const application = await ensureStatus(tx, input, 'INTERVIEW', 'Interview recorded by explicit user/system lifecycle event', `interview:${input.userId}:${input.sourceEventId ?? input.applicationId}`);
    const interview = await db.interview.create({ data: { userId: input.userId, applicationId: application.id, date, type, company, role, round, interviewer, meetingUrl, sourceEventId: input.sourceEventId } });
    await tx.auditLog.create({ data: { userId: input.userId, action: 'INTERVIEW_RECORDED', resource: 'Interview', resourceId: interview.id, details: { applicationId: input.applicationId, sourceEventId: input.sourceEventId ?? null } } });
    return interview;
  });
  try {
    return await persist();
  } catch (error) {
    if (!input.sourceEventId || !isUniqueConstraint(error)) throw error;
    return withTenant(input.userId, async (tx) => {
      const db = tx as any;
      const replay = await db.interview.findUnique({ where: { userId_sourceEventId: { userId: input.userId, sourceEventId: input.sourceEventId! } } });
      if (!replay || !sameInterviewEvent(replay, input, { type, company, role, interviewer, meetingUrl, date, round })) throw error;
      return replay;
    });
  }
}

export async function recordOffer(input: OfferInput) {
  validateBaseLifecycleInput(input);
  const company = required(input.company, 'Company');
  const role = required(input.role, 'Role');
  const currency = optionalText(input.currency, 20);
  const benefits = optionalText(input.benefits, 5_000);
  const startDate = optionalDate(input.startDate, 'Offer start date');
  const expiresAt = optionalDate(input.expiresAt, 'Offer expiry date');
  if (startDate && expiresAt && expiresAt < startDate) throw new Error('Offer expiry must be after the start date');
  if (input.salaryOffered !== undefined && (!Number.isFinite(input.salaryOffered) || input.salaryOffered < 0 || input.salaryOffered > 1_000_000_000)) throw new Error('Offer salary is invalid');
  const persist = () => withTenant(input.userId, async (tx) => {
    const db = tx as any;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:offer:${input.sourceEventId ?? input.applicationId}`}, 0))`;
    const existing = input.sourceEventId ? await db.offer.findUnique({ where: { userId_sourceEventId: { userId: input.userId, sourceEventId: input.sourceEventId } } }) : null;
    if (existing) {
      if (!sameOfferEvent(existing, input, { company, role, salaryOffered: input.salaryOffered, currency, benefits, startDate, expiresAt })) throw new Error('Offer source event conflicts with an existing lifecycle event');
      return existing;
    }
    const application = await ensureStatus(tx, input, 'OFFER', 'Offer recorded by explicit user/system lifecycle event', `offer:${input.userId}:${input.sourceEventId ?? input.applicationId}`);
    const offer = await db.offer.create({ data: { userId: input.userId, applicationId: input.applicationId, company, role, salaryOffered: input.salaryOffered, currency, benefits, startDate, expiresAt, sourceEventId: input.sourceEventId } });
    await tx.auditLog.create({ data: { userId: input.userId, action: 'OFFER_RECORDED', resource: 'Offer', resourceId: offer.id, details: { applicationId: input.applicationId, sourceEventId: input.sourceEventId ?? null } } });
    return offer;
  });
  try {
    return await persist();
  } catch (error) {
    if (!input.sourceEventId || !isUniqueConstraint(error)) throw error;
    return withTenant(input.userId, async (tx) => {
      const db = tx as any;
      const replay = await db.offer.findUnique({ where: { userId_sourceEventId: { userId: input.userId, sourceEventId: input.sourceEventId! } } });
      if (!replay || !sameOfferEvent(replay, input, { company, role, salaryOffered: input.salaryOffered, currency, benefits, startDate, expiresAt })) throw error;
      return replay;
    });
  }
}

export async function decideOffer(input: BaseLifecycleInput & { offerId: string; decision: OfferDecision }) {
  validateBaseLifecycleInput(input);
  if (typeof input.offerId !== 'string' || !input.offerId.trim() || input.offerId.length > 200 || hasControlCharacters(input.offerId)) throw new Error('Offer identity is required and bounded');
  if (typeof input.sourceEventId !== 'string' || !input.sourceEventId.trim() || input.sourceEventId.length > 200 || hasControlCharacters(input.sourceEventId)) throw new Error('Offer decision idempotency identity is required and bounded');
  if (!['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'].includes(input.decision)) throw new Error('Unsupported offer decision');
  const targetApplicationStatus: ApplicationStatus = input.decision === 'ACCEPTED' ? 'ACCEPTED' : input.decision === 'WITHDRAWN' ? 'WITHDRAWN' : 'REJECTED';
  return withTenant(input.userId, async (tx) => {
    const db = tx as any;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:offer-decision:${input.offerId}`}, 0))`;
    const offer = await db.offer.findFirst({ where: { id: input.offerId, userId: input.userId, applicationId: input.applicationId } });
    if (!offer) throw new Error('Offer does not belong to tenant/application');
    if (offer.status === input.decision) return offer;
    if (offer.status !== 'PENDING') throw new Error('Offer has already been decided');
    await ensureStatus(tx, input, targetApplicationStatus, `Offer explicitly marked ${input.decision}`, `offer-decision:${input.userId}:${offer.id}:${input.decision}:${input.sourceEventId}`);
    const changed = await db.offer.updateMany({ where: { id: offer.id, userId: input.userId, applicationId: input.applicationId, status: 'PENDING' }, data: { status: input.decision } });
    if (changed.count !== 1) throw new Error('Offer changed concurrently');
    const updated = await db.offer.findUniqueOrThrow({ where: { id: offer.id } });
    await tx.auditLog.create({ data: { userId: input.userId, action: 'OFFER_DECIDED', resource: 'Offer', resourceId: offer.id, details: { applicationId: input.applicationId, decision: input.decision, idempotencyKey: input.sourceEventId } } });
    return updated;
  });
}
