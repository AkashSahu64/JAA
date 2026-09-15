import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';

export const EMAIL_OUTCOME_CLASSES = [
  'APPLICATION_RECEIVED', 'REJECTION', 'ASSESSMENT', 'INTERVIEW_INVITATION',
  'RECRUITER_MESSAGE', 'INTERVIEW_SCHEDULING', 'OFFER', 'WITHDRAWAL', 'UNCLASSIFIED',
] as const;
export type EmailOutcomeClass = typeof EMAIL_OUTCOME_CLASSES[number];
export type EmailConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

const lifecycleTargets = {
  REJECTION: 'REJECTED',
  ASSESSMENT: 'ASSESSMENT',
  INTERVIEW_INVITATION: 'INTERVIEW',
  INTERVIEW_SCHEDULING: 'INTERVIEW',
  OFFER: 'OFFER',
  WITHDRAWAL: 'WITHDRAWN',
} as const;
export type EmailLifecycleTarget = typeof lifecycleTargets[keyof typeof lifecycleTargets];

export function lifecycleTargetForEmailOutcome(classification: EmailOutcomeClass): EmailLifecycleTarget | null {
  return lifecycleTargets[classification as keyof typeof lifecycleTargets] ?? null;
}

export interface EmailMessageInput {
  userId: string;
  /** Provenance label for the ingestion boundary; raw provider content is never persisted. */
  source?: string;
  messageId: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt: Date;
  applicationId?: string;
}

export interface ClassifiedEmailOutcome {
  classification: EmailOutcomeClass;
  confidence: EmailConfidence;
  evidence: { matchedSignals: string[]; parserVersion: string };
}

const parserVersion = 'email-outcome-v1';
const MAX_EMAIL_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const rules: Array<{ classification: EmailOutcomeClass; confidence: EmailConfidence; signals: RegExp[] }> = [
  { classification: 'OFFER', confidence: 'HIGH', signals: [/offer of employment/i, /pleased to offer/i, /employment offer/i] },
  { classification: 'INTERVIEW_SCHEDULING', confidence: 'HIGH', signals: [/schedule (?:an? )?interview/i, /select a time for (?:your )?interview/i, /calendar invite.*interview/i] },
  { classification: 'INTERVIEW_INVITATION', confidence: 'HIGH', signals: [/invite you to an interview/i, /interview invitation/i, /move forward.*interview/i] },
  { classification: 'ASSESSMENT', confidence: 'HIGH', signals: [/coding assessment/i, /technical assessment/i, /complete.*assessment/i, /online test/i] },
  { classification: 'REJECTION', confidence: 'HIGH', signals: [/not moving forward/i, /we (?:have )?decided not to proceed/i, /regret to inform/i, /application.*unsuccessful/i] },
  { classification: 'WITHDRAWAL', confidence: 'HIGH', signals: [/application (?:has been )?withdrawn/i, /position has been withdrawn/i, /withdrawn the requisition/i] },
  { classification: 'APPLICATION_RECEIVED', confidence: 'HIGH', signals: [/application received/i, /thank you for applying/i, /we received your application/i] },
  { classification: 'RECRUITER_MESSAGE', confidence: 'MEDIUM', signals: [/recruiter|talent acquisition|hiring manager/i] },
];

function hash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function emailReplayMatches(
  existing: Pick<{ source: string; senderHash: string; subjectHash: string; bodyHash: string; receivedAt: Date }, 'source' | 'senderHash' | 'subjectHash' | 'bodyHash' | 'receivedAt'>,
  input: EmailMessageInput,
): boolean {
  return existing.source === (input.source ?? 'MANUAL')
    && existing.senderHash === hash(input.sender)
    && existing.subjectHash === hash(input.subject)
    && existing.bodyHash === hash(input.body)
    && existing.receivedAt.getTime() === input.receivedAt.getTime();
}

export function classifyEmail(input: Pick<EmailMessageInput, 'sender' | 'subject' | 'body'>): ClassifiedEmailOutcome {
  if (!input || typeof input.subject !== 'string' || typeof input.body !== 'string') {
    return { classification: 'UNCLASSIFIED', confidence: 'LOW', evidence: { matchedSignals: [], parserVersion } };
  }
  const text = `${input.subject}\n${input.body}`.slice(0, 200_000);
  const matches = rules.flatMap(rule => {
    const matchedSignals = rule.signals.filter(signal => signal.test(text)).map(signal => signal.source);
    return matchedSignals.length ? [{ rule, matchedSignals }] : [];
  });
  const classifications = new Set(matches.map(match => match.rule.classification));
  if (classifications.size === 1) {
    const match = matches[0]!;
    return {
      classification: match.rule.classification,
      confidence: match.rule.confidence,
      evidence: { matchedSignals: matches.flatMap(item => item.matchedSignals).slice(0, 20), parserVersion },
    };
  }
  if (classifications.size > 1) {
    return { classification: 'UNCLASSIFIED', confidence: 'LOW', evidence: { matchedSignals: matches.flatMap(item => item.matchedSignals).slice(0, 20), parserVersion } };
  }
  return { classification: 'UNCLASSIFIED', confidence: 'LOW', evidence: { matchedSignals: [], parserVersion } };
}

export function validateEmailMessageInput(input: EmailMessageInput): void {
  if (!input || typeof input.userId !== 'string' || !input.userId.trim()
    || hasControlCharacters(input.userId)
    || typeof input.messageId !== 'string' || !input.messageId.trim() || input.messageId.length > 512 || hasControlCharacters(input.messageId)) {
    throw new Error('Invalid email identity');
  }
  if (input.source !== undefined && (typeof input.source !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.source))) {
    throw new Error('Invalid email source');
  }
  if (input.applicationId !== undefined && (typeof input.applicationId !== 'string' || !input.applicationId.trim() || input.applicationId.length > 200 || hasControlCharacters(input.applicationId))) {
    throw new Error('Invalid email application identity');
  }
  if (typeof input.sender !== 'string' || !input.sender.trim()
    || typeof input.subject !== 'string' || !input.subject.trim()
    || typeof input.body !== 'string' || !input.body.trim()
    || input.sender.length > 512 || input.subject.length > 20_000 || input.body.length > 2_000_000
    || hasControlCharacters(input.sender) || hasControlCharacters(input.subject)) {
    throw new Error('Email exceeds safety limits');
  }
  if (!(input.receivedAt instanceof Date) || !Number.isFinite(input.receivedAt.getTime())
    || input.receivedAt.getTime() > Date.now() + MAX_EMAIL_CLOCK_SKEW_MS) throw new Error('Invalid email timestamp');
}

/** Stores hashes and bounded parser evidence; raw email content is never persisted. */
export async function ingestEmailOutcome(input: EmailMessageInput) {
  validateEmailMessageInput(input);
  const outcome = classifyEmail(input);
  const persist = () => withTenant(input.userId, async (tx) => {
    // The API workspace can resolve a separately built database package during incremental typechecks.
    // Keep the runtime delegate strongly shaped by Prisma generation while remaining compatible with that package boundary.
    const emailOutcome = (tx as typeof tx & { emailOutcome: typeof prisma.emailOutcome }).emailOutcome;
    const existing = await emailOutcome.findUnique({ where: { userId_messageId: { userId: input.userId, messageId: input.messageId } } });
    if (existing) {
      if (!emailReplayMatches(existing, input)) throw new Error('Email message identity conflicts with an existing delivery');
      return existing;
    }
    if (input.applicationId) {
      const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId }, select: { id: true } });
      if (!application) throw new Error('Application does not belong to tenant');
    }
    const record = await emailOutcome.create({ data: {
      userId: input.userId, applicationId: input.applicationId, source: input.source ?? 'MANUAL', messageId: input.messageId,
      senderHash: hash(input.sender), subjectHash: hash(input.subject), bodyHash: hash(input.body),
      classification: outcome.classification, confidence: outcome.confidence, evidence: outcome.evidence as Prisma.InputJsonValue,
      receivedAt: input.receivedAt,
    } });
    await Promise.all([
      tx.auditLog.create({ data: { userId: input.userId, action: 'EMAIL_OUTCOME_INGESTED', resource: 'EmailOutcome', resourceId: record.id, details: { messageId: input.messageId, applicationId: input.applicationId ?? null, source: input.source ?? 'MANUAL', classification: outcome.classification, confidence: outcome.confidence, parserVersion } } }),
      outcome.classification === 'UNCLASSIFIED' ? Promise.resolve() : tx.outboxEvent.create({ data: {
        userId: input.userId, aggregateType: 'EmailOutcome', aggregateId: record.id, eventType: 'email.outcome.detected',
        payload: { applicationId: input.applicationId ?? null, classification: outcome.classification, confidence: outcome.confidence },
        schemaVersion: 1, correlationId: record.id, idempotencyKey: `email-outcome-detected:${record.id}`,
      } }),
    ]);
    return record;
  });
  try {
    return await persist();
  } catch (error) {
    // A duplicate mailbox delivery can race the initial insert. Re-read only
    // after the failed transaction has rolled back, so the tenant transaction
    // remains usable and RLS is applied to the replay.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return withTenant(input.userId, async (tx) => {
        const emailOutcome = (tx as typeof tx & { emailOutcome: typeof prisma.emailOutcome }).emailOutcome;
        const existing = await emailOutcome.findUnique({ where: { userId_messageId: { userId: input.userId, messageId: input.messageId } } });
        if (!existing) throw error;
        if (!emailReplayMatches(existing, input)) throw new Error('Email message identity conflicts with an existing delivery');
        return existing;
      });
    }
    throw error;
  }
}

/** Explicit user/reviewer mapping; linking never changes application lifecycle state. */
export async function linkEmailOutcome(userId: string, outcomeId: string, applicationId: string | null) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 200 || typeof outcomeId !== 'string' || !outcomeId.trim() || outcomeId.length > 200
    || hasControlCharacters(userId) || hasControlCharacters(outcomeId)
    || (applicationId !== null && (typeof applicationId !== 'string' || !applicationId.trim() || applicationId.length > 200 || hasControlCharacters(applicationId)))) throw new Error('Email outcome identity is required');
  return withTenant(userId, async (tx) => {
    const db = tx as any;
    const outcome = await db.emailOutcome.findFirst({ where: { id: outcomeId, userId }, select: { id: true, applicationId: true } });
    if (!outcome) throw new Error('Email outcome not found');
    if (applicationId) {
      const application = await tx.application.findFirst({ where: { id: applicationId, userId }, select: { id: true } });
      if (!application) throw new Error('Application does not belong to tenant');
    }
    const targetChanged = outcome.applicationId !== applicationId;
    const updated = await db.emailOutcome.update({ where: { id: outcome.id }, data: {
      applicationId,
      ...(targetChanged ? { reviewedAt: null, reviewedBy: null } : {}),
    } });
    await tx.auditLog.create({ data: { userId, action: 'EMAIL_OUTCOME_LINKED', resource: 'EmailOutcome', resourceId: outcome.id, details: { previousApplicationId: outcome.applicationId, applicationId, lifecycleMutation: false } } });
    return updated;
  });
}

/** Record the authenticated user's explicit review without mutating application lifecycle state. */
export async function reviewEmailOutcome(userId: string, outcomeId: string) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 200
    || typeof outcomeId !== 'string' || !outcomeId.trim() || outcomeId.length > 200
    || hasControlCharacters(userId) || hasControlCharacters(outcomeId)) throw new Error('Email outcome identity is required');
  return withTenant(userId, async (tx) => {
    const db = tx as any;
    const outcome = await db.emailOutcome.findFirst({ where: { id: outcomeId, userId }, select: { id: true, applicationId: true, reviewedAt: true, reviewedBy: true } });
    if (!outcome) throw new Error('Email outcome not found');
    if (!outcome.applicationId) throw new Error('Email outcome must be linked to an application before review');
    if (outcome.reviewedAt instanceof Date && Number.isFinite(outcome.reviewedAt.getTime()) && outcome.reviewedBy === userId) return outcome;
    const reviewedAt = new Date();
    const updated = await db.emailOutcome.update({ where: { id: outcome.id, userId }, data: { reviewedAt, reviewedBy: userId } });
    await tx.auditLog.create({ data: { userId, action: 'EMAIL_OUTCOME_REVIEWED', resource: 'EmailOutcome', resourceId: outcome.id, details: { applicationId: outcome.applicationId, reviewedBy: userId, reviewedAt: reviewedAt.toISOString(), lifecycleMutation: false } } });
    return updated;
  });
}

/** Apply a previously reviewed, linked outcome through the audited state machine. Classification alone never mutates lifecycle state. */
export async function applyEmailOutcome(input: { userId: string; outcomeId: string; expectedVersion: number; idempotencyKey: string; correlationId: string }) {
  if (typeof input?.userId !== 'string' || !input.userId.trim() || input.userId.length > 200
    || typeof input.outcomeId !== 'string' || !input.outcomeId.trim() || input.outcomeId.length > 200
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 300
    || typeof input.correlationId !== 'string' || !input.correlationId.trim() || input.correlationId.length > 200
    || hasControlCharacters(input.userId) || hasControlCharacters(input.outcomeId) || hasControlCharacters(input.idempotencyKey) || hasControlCharacters(input.correlationId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('Valid lifecycle application input is required');
  }
  return withTenant(input.userId, async (tx) => {
    const db = tx as any;
    const outcome = await db.emailOutcome.findFirst({ where: { id: input.outcomeId, userId: input.userId }, select: { id: true, applicationId: true, classification: true, reviewedAt: true, reviewedBy: true } });
    if (!outcome) throw new Error('Email outcome not found');
    if (!outcome.applicationId) throw new Error('Email outcome must be linked to an application');
    if (!(outcome.reviewedAt instanceof Date) || !Number.isFinite(outcome.reviewedAt.getTime()) || outcome.reviewedBy !== input.userId) {
      throw new Error('Email outcome must be explicitly reviewed by the authenticated user before lifecycle application');
    }
    const target = lifecycleTargetForEmailOutcome(outcome.classification as EmailOutcomeClass);
    if (!target) throw new Error('Email outcome classification is not lifecycle actionable');
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: outcome.applicationId,
      userId: input.userId,
      toStatus: target,
      expectedVersion: input.expectedVersion,
      actorType: 'USER',
      actorId: input.userId,
      reason: `Reviewed email outcome ${outcome.id} applied as ${target}`,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      metadata: { emailOutcomeId: outcome.id, classification: outcome.classification, lifecycleMutation: true },
    });
    if (transitioned.replayed) return { outcomeId: outcome.id, target, ...transitioned };
    const reviewedAt = new Date();
    await tx.emailOutcome.update({ where: { id: outcome.id, userId: input.userId }, data: { reviewedAt, reviewedBy: input.userId } });
    await tx.auditLog.create({ data: { userId: input.userId, action: 'EMAIL_OUTCOME_LIFECYCLE_APPLIED', resource: 'EmailOutcome', resourceId: outcome.id, details: { applicationId: outcome.applicationId, target, idempotencyKey: input.idempotencyKey, reviewedBy: input.userId, reviewedAt: reviewedAt.toISOString() } } });
    return { outcomeId: outcome.id, target, ...transitioned };
  });
}
