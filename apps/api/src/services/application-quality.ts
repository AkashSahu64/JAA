import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  APPLICATION_QUALITY_VERSION,
  evaluateApplicationQuality,
  type QualityRuleCondition,
  type QualityUserRule,
} from '@jobagent/job-engine';
import { withTenant } from '@jobagent/database';
import { transitionApplicationInTenant } from './application-state-machine';

export class ApplicationQualityError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'ApplicationQualityError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function conditions(value: Prisma.JsonValue): QualityRuleCondition[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item): QualityRuleCondition | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    const operators = new Set(['gte', 'lte', 'eq', 'neq', 'contains', 'not_contains', 'in', 'not_in']);
    const validValue = typeof candidate.value === 'string' || typeof candidate.value === 'number' || typeof candidate.value === 'boolean'
      || (Array.isArray(candidate.value) && candidate.value.every(value => typeof value === 'string'));
    return typeof candidate.field === 'string' && operators.has(String(candidate.operator)) && validValue
      ? { field: candidate.field, operator: candidate.operator as QualityRuleCondition['operator'], value: candidate.value as QualityRuleCondition['value'] }
      : null;
  });
  return parsed.every((condition): condition is QualityRuleCondition => condition !== null) ? parsed : null;
}

function hasVerifiedProvenance(value: Prisma.JsonValue): { valid: boolean; count: number } {
  if (!Array.isArray(value)) return { valid: false, count: 0 };
  const valid = value.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).sourceFactId === 'string'
    && typeof (item as Record<string, unknown>).sourceChecksum === 'string');
  return { valid: valid && value.length > 0, count: value.length };
}

function qualityRules(rules: Array<{ id: string; name: string; enabled: boolean; conditions: Prisma.JsonValue; action: string; priority: number }>): QualityUserRule[] {
  return rules.flatMap(rule => {
    const parsed = conditions(rule.conditions);
    return parsed === null ? [] : [{ ...rule, conditions: parsed }];
  });
}

export interface ExecuteApplicationQualityInput {
  userId: string;
  applicationId: string;
  searchProfileId: string;
  now?: Date;
}

export async function executeApplicationQuality(input: ExecuteApplicationQualityInput) {
  if (!input.userId.trim() || !input.applicationId.trim() || !input.searchProfileId.trim()) {
    throw new ApplicationQualityError('INVALID', 'User, application, and search profile identifiers are required');
  }
  const now = input.now ?? new Date();
  const day = utcDay(now);
  return withTenant(input.userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:application-quality:${day.toISOString()}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.applicationId}:application-quality`}, 0))`;
    const [application, profile, rules, reserved] = await Promise.all([
      tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId }, include: { job: true, resumeVersion: true } }),
      tx.searchProfile.findFirst({ where: { id: input.searchProfileId, userId: input.userId, isActive: true } }),
      tx.userRule.findMany({ where: { userId: input.userId, enabled: true } }),
      tx.dailyApplicationBudgetReservation.findUnique({ where: { applicationId: input.applicationId } }),
    ]);
    if (!application || !profile) throw new ApplicationQualityError('NOT_FOUND', 'Application or active search profile not found');
    const jobMatch = await tx.jobMatch.findFirst({ where: { userId: input.userId, jobId: application.jobId } });
    const otherReservations = await tx.dailyApplicationBudgetReservation.count({
      where: { userId: input.userId, day, applicationId: { not: application.id } },
    });
    const provenance = hasVerifiedProvenance(application.resumeVersion.sourceFacts);
    const result = evaluateApplicationQuality({
      job: { active: application.job.isActive, company: application.job.company, title: application.job.title, source: application.job.source },
      profile, scores: { match: jobMatch?.overall ?? null, ats: application.resumeVersion.atsScoreOverall },
      truth: { valid: provenance.valid, verifiedClaimCount: provenance.count },
      artifact: { contentReady: Boolean(application.resumeVersion.content.trim()), atsEvidenceReady: application.resumeVersion.atsScoreData !== null },
      dailyCapacity: { reserved: otherReservations, available: Boolean(reserved) || otherReservations < profile.maxApplicationsPerDay },
      rules: qualityRules(rules),
    });
    const inputHash = hash({ applicationId: application.id, searchProfileId: profile.id, jobMatch: jobMatch?.profileHash, ats: application.resumeVersion.atsScoreData, sourceFacts: application.resumeVersion.sourceFacts, profile: { updatedAt: profile.updatedAt, minMatchScore: profile.minMatchScore, minATSScore: profile.minATSScore, maxApplicationsPerDay: profile.maxApplicationsPerDay }, rules: qualityRules(rules), day: day.toISOString(), result });
    const existingDecision = await tx.applicationQualityDecision.findUnique({
      where: { applicationId_inputHash: { applicationId: application.id, inputHash } },
    });
    let reservedByDecision = false;
    if (result.decision === 'PASS' && !reserved) {
      await tx.dailyApplicationBudgetReservation.create({ data: { userId: input.userId, applicationId: application.id, day } });
      reservedByDecision = true;
    }
    const decision = existingDecision ?? await tx.applicationQualityDecision.create({
      data: { applicationId: application.id, userId: input.userId, decision: result.decision, version: APPLICATION_QUALITY_VERSION, evidence: result as unknown as Prisma.InputJsonValue, inputHash },
    });
    const toStatus = result.decision === 'PASS' ? 'QUALIFIED' : result.decision === 'SKIPPED' ? 'SKIPPED' : null;
    if (toStatus && application.status === 'DISCOVERED') {
      await transitionApplicationInTenant(tx, {
        applicationId: application.id, userId: input.userId, toStatus, expectedVersion: application.version,
        actorType: 'WORKER', reason: `Application quality gate decision: ${result.decision}`,
        idempotencyKey: `application-quality:${inputHash}`, correlationId: application.id,
        metadata: { version: result.version, decision: result.decision, inputHash },
      });
    }
    await tx.application.update({ where: { id: application.id }, data: { matchScore: jobMatch?.overall, atsScore: application.resumeVersion.atsScoreOverall, qualityScore: result as unknown as Prisma.InputJsonValue } });
    if (!existingDecision) {
      await tx.auditLog.create({ data: { userId: input.userId, action: 'APPLICATION_QUALITY_EVALUATED', resource: 'Application', resourceId: application.id, details: { decision: result.decision, version: result.version, inputHash, reserved: reservedByDecision } } });
    }
    return { decision, result };
  });
}
