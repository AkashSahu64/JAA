import { Prisma, type ApplicationAnswer } from '@prisma/client';
import { withTenant } from '@jobagent/database';

export type ApplicationAnswerDecision = 'APPROVE' | 'REJECT';
export type ApplicationAnswerSource = 'USER_PROFILE' | 'USER_INPUT' | 'COVER_LETTER' | 'AI_SUGGESTION';
export type ApplicationAnswerValue = string | boolean | readonly string[] | { profileKey: string } | { source: 'coverLetter' };
const applicationAnswerSources = new Set<ApplicationAnswerSource>(['USER_PROFILE', 'USER_INPUT', 'COVER_LETTER', 'AI_SUGGESTION']);
const applicationProfileKeys = new Set(['firstName', 'lastName', 'email', 'phone', 'location', 'linkedinUrl', 'websiteUrl']);
const MAX_ANSWER_TEXT_LENGTH = 20_000;
const MAX_ANSWER_OPTIONS = 100;
const MAX_ANSWER_OPTION_LENGTH = 500;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !hasControlCharacters(value);
}

export class ApplicationAnswerError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'ApplicationAnswerError';
  }
}

function isSupportedValue(value: unknown, source: ApplicationAnswerSource): value is ApplicationAnswerValue {
  if (source === 'USER_PROFILE') return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { profileKey?: unknown }).profileKey === 'string'
    && applicationProfileKeys.has((value as { profileKey: string }).profileKey));
  if (source === 'COVER_LETTER') return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as { source?: unknown }).source === 'coverLetter');
  return (typeof value === 'string' && value.length <= MAX_ANSWER_TEXT_LENGTH)
    || typeof value === 'boolean'
    || (Array.isArray(value) && value.length <= MAX_ANSWER_OPTIONS
      && value.every(item => typeof item === 'string' && item.length <= MAX_ANSWER_OPTION_LENGTH));
}

function isSourceConsistent(value: ApplicationAnswerValue, source: ApplicationAnswerSource, provenance: Record<string, unknown> | undefined): boolean {
  if (!provenance || provenance.source !== source) return false;
  if (source === 'USER_PROFILE') return provenance.profileKey === (value as { profileKey: string }).profileKey;
  return source !== 'COVER_LETTER' || (value as { source: 'coverLetter' }).source === 'coverLetter';
}

function isValidExpectedVersion(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1);
}

export function isValidApplicationAnswerProvenance(value: unknown): value is Record<string, unknown> {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 32) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= 8_192;
  } catch {
    return false;
  }
}

export async function saveApplicationAnswerDraft(input: {
  userId: string;
  applicationId: string;
  questionId: string;
  value: ApplicationAnswerValue;
  source: ApplicationAnswerSource;
  provenance?: Record<string, unknown>;
  expectedVersion?: number;
}): Promise<ApplicationAnswer> {
  if (!isSafeIdentifier(input.userId) || !isSafeIdentifier(input.applicationId) || !isSafeIdentifier(input.questionId) || !isSupportedValue(input.value, input.source)
    || !applicationAnswerSources.has(input.source) || !isValidApplicationAnswerProvenance(input.provenance)
    || !isSourceConsistent(input.value, input.source, input.provenance) || !isValidExpectedVersion(input.expectedVersion)) {
    throw new ApplicationAnswerError('INVALID', 'Application answer identifiers and a supported answer value are required');
  }
  return withTenant(input.userId, async tx => {
    const question = await tx.applicationQuestion.findFirst({
      where: { id: input.questionId, applicationId: input.applicationId, userId: input.userId },
      select: { id: true, risk: true },
    });
    if (!question) throw new ApplicationAnswerError('NOT_FOUND', 'Application question not found');
    const current = await tx.applicationAnswer.findUnique({ where: { questionId: question.id } });
    if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion) {
      throw new ApplicationAnswerError('CONFLICT', 'Application answer was changed by another request');
    }
    const answer = await tx.applicationAnswer.upsert({
      where: { questionId: question.id },
      update: {
        value: input.value as Prisma.InputJsonValue,
        source: input.source,
        provenance: { ...(input.provenance ?? {}), source: input.source },
        approved: false,
        approvedAt: null,
        approvedBy: null,
        version: { increment: 1 },
      },
      create: {
        userId: input.userId,
        applicationId: input.applicationId,
        questionId: question.id,
        value: input.value as Prisma.InputJsonValue,
        source: input.source,
        provenance: { ...(input.provenance ?? {}), source: input.source },
        approved: false,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'APPLICATION_ANSWER_DRAFT_SAVED',
        resource: 'ApplicationAnswer',
        resourceId: answer.id,
        details: { applicationId: input.applicationId, questionId: question.id, source: input.source, risk: question.risk, version: answer.version },
      },
    });
    return answer;
  });
}

export async function decideApplicationAnswer(input: {
  userId: string;
  applicationId: string;
  answerId: string;
  decision: ApplicationAnswerDecision;
  expectedVersion?: number;
}): Promise<ApplicationAnswer | null> {
  if (!isSafeIdentifier(input.userId) || !isSafeIdentifier(input.applicationId) || !isSafeIdentifier(input.answerId)
    || (input.decision !== 'APPROVE' && input.decision !== 'REJECT') || !isValidExpectedVersion(input.expectedVersion)) {
    throw new ApplicationAnswerError('INVALID', 'A valid answer decision and version are required');
  }
  return withTenant(input.userId, async tx => {
    const answer = await tx.applicationAnswer.findFirst({
      where: { id: input.answerId, applicationId: input.applicationId, userId: input.userId },
      include: { question: { select: { id: true, risk: true } } },
    });
    if (!answer) throw new ApplicationAnswerError('NOT_FOUND', 'Application answer not found');
    if (input.expectedVersion !== undefined && answer.version !== input.expectedVersion) {
      throw new ApplicationAnswerError('CONFLICT', 'Application answer was changed by another request');
    }
    if (input.decision === 'REJECT') {
      if (answer.approved) throw new ApplicationAnswerError('CONFLICT', 'Approved application answers must be replaced with a new draft');
      await tx.applicationAnswer.delete({ where: { id: answer.id } });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          action: 'APPLICATION_ANSWER_REJECTED',
          resource: 'ApplicationAnswer',
          resourceId: answer.id,
          details: { applicationId: input.applicationId, questionId: answer.question.id, version: answer.version },
        },
      });
      return null;
    }
    if (!isSourceConsistent(answer.value as ApplicationAnswerValue, answer.source as ApplicationAnswerSource,
      answer.provenance && typeof answer.provenance === 'object' && !Array.isArray(answer.provenance) ? answer.provenance as Record<string, unknown> : undefined)) {
      throw new ApplicationAnswerError('INVALID', 'Answer provenance does not match its trusted source reference');
    }
    const approved = await tx.applicationAnswer.update({
      where: { id: answer.id },
      data: { approved: true, approvedAt: new Date(), approvedBy: input.userId, version: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'APPLICATION_ANSWER_APPROVED',
        resource: 'ApplicationAnswer',
        resourceId: answer.id,
        details: { applicationId: input.applicationId, questionId: answer.question.id, risk: answer.question.risk, version: approved.version },
      },
    });
    return approved;
  });
}
