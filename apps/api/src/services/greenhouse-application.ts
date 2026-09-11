import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import {
  GreenhouseApplicationAdapter,
  type ApprovedGreenhouseProfile,
  type ApplicationFormAssessment,
  type GreenhouseFillResult,
  type GreenhouseFormPort,
} from '@jobagent/job-engine';
import type { Page } from 'playwright';
import {
  BrowserSessionManager,
  type StartBrowserSessionInput,
} from './browser-session-manager';
import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';
import { requestHumanVerification } from './human-verification';
import { transitionApplicationInTenant } from './application-state-machine';

const maxFormSteps = 10;
const sessionLifetimeMs = 15 * 60 * 1000;

type BrowserSessionPort = {
  start(input: StartBrowserSessionInput): Promise<{ session: { externalRef: string }; replayed: boolean }>;
  withPage<T>(userId: string, externalRef: string, operation: (page: Page) => Promise<T>): Promise<T>;
  close(userId: string, externalRef: string, correlationId: string): Promise<void>;
};

type FormPortFactory = (page: Page) => GreenhouseFormPort;

type PreparedApplication = {
  targetUrl: string;
  profile: ApprovedGreenhouseProfile;
  profileVersion: number;
  status: string;
};

export type ApplicationFormProvider = 'GREENHOUSE' | 'LEVER';

export interface ExecuteGreenhouseApplicationInput {
  userId: string;
  applicationId: string;
  workerId: string;
  correlationId: string;
  idempotencyKey: string;
  provider?: ApplicationFormProvider;
}

export type GreenhouseApplicationOutcome = 'FORM_FILLED' | 'REVIEW_REQUIRED' | 'HUMAN_VERIFICATION_REQUIRED';

export class GreenhouseApplicationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'GreenhouseApplicationError';
  }
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new GreenhouseApplicationError('INVALID', `${name} is required`);
}

function location(profile: { locationCity: string | null; locationState: string | null; locationCountry: string | null }): string | undefined {
  const value = [profile.locationCity, profile.locationState, profile.locationCountry]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');
  return value || undefined;
}

export function approvedGreenhouseProfile(profile: {
  fullName: string;
  email: string;
  phone: string | null;
  locationCity: string | null;
  locationState: string | null;
  locationCountry: string | null;
  linkedIn: string | null;
  portfolio: string | null;
}): ApprovedGreenhouseProfile {
  const [firstName, ...lastName] = profile.fullName.trim().split(/\s+/);
  return {
    firstName,
    lastName: lastName.join(' ') || undefined,
    email: profile.email,
    phone: profile.phone ?? undefined,
    location: location(profile),
    linkedinUrl: profile.linkedIn ?? undefined,
    websiteUrl: profile.portfolio ?? undefined,
  };
}

function providerHost(targetUrl: string, provider: ApplicationFormProvider): string {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new GreenhouseApplicationError('INVALID', 'Application URL is invalid');
  }
  const host = target.hostname.toLowerCase();
  const root = provider === 'GREENHOUSE' ? 'greenhouse.io' : 'lever.co';
  if (target.protocol !== 'https:' || (host !== root && !host.endsWith(`.${root}`))) {
    throw new GreenhouseApplicationError('INVALID', `Application URL is not a ${provider} HTTPS host`);
  }
  return host;
}

async function loadPreparedApplication(input: ExecuteGreenhouseApplicationInput): Promise<PreparedApplication> {
  return withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({
      where: { id: input.applicationId, userId: input.userId },
      include: { job: { select: { applicationUrl: true } } },
    });
    const profile = await tx.userProfile.findUnique({ where: { userId: input.userId } });
    if (!application || !profile) throw new GreenhouseApplicationError('NOT_FOUND', 'Application or user profile not found');
    if (application.status === 'FORM_FILLED') {
      return { targetUrl: application.job.applicationUrl, profile: approvedGreenhouseProfile(profile), profileVersion: profile.version, status: application.status };
    }
    if (application.status !== 'APPLICATION_STARTED') {
      throw new GreenhouseApplicationError('CONFLICT', 'Application is not ready for Greenhouse form completion');
    }
    return { targetUrl: application.job.applicationUrl, profile: approvedGreenhouseProfile(profile), profileVersion: profile.version, status: application.status };
  });
}

function assessmentFor(result: GreenhouseFillResult, fieldId: string): ApplicationFormAssessment | undefined {
  return result.assessments.find(assessment => assessment.fieldId === fieldId);
}

function verificationAssessment(result: GreenhouseFillResult): ApplicationFormAssessment | undefined {
  return result.assessments.find(assessment => assessment.disposition === 'HUMAN_VERIFICATION_REQUIRED'
    && result.requiredBlockingFieldIds.includes(assessment.fieldId));
}

function needsReview(result: GreenhouseFillResult): boolean {
  return result.validationErrors.length > 0 || result.requiredBlockingFieldIds.length > 0;
}

async function persistFormResult(
  input: ExecuteGreenhouseApplicationInput,
  result: GreenhouseFillResult,
  profileVersion: number,
): Promise<void> {
  await withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
    if (!application) throw new GreenhouseApplicationError('NOT_FOUND', 'Application not found');
    for (const [orderIndex, field] of result.fields.entries()) {
      const assessment = assessmentFor(result, field.id);
      if (!assessment) continue;
      const question = await tx.applicationQuestion.upsert({
        where: { applicationId_externalKey: { applicationId: application.id, externalKey: field.id } },
        update: {
          label: field.label,
          normalizedKey: field.name,
          fieldType: field.kind,
          required: field.required,
          risk: assessment.disposition,
          options: field.options ? field.options as Prisma.InputJsonValue : Prisma.JsonNull,
          source: { provider: input.provider ?? 'GREENHOUSE', step: result.step },
          orderIndex,
        },
        create: {
          userId: input.userId,
          applicationId: application.id,
          externalKey: field.id,
          label: field.label,
          normalizedKey: field.name,
          fieldType: field.kind,
          required: field.required,
          risk: assessment.disposition,
          options: field.options ? field.options as Prisma.InputJsonValue : Prisma.JsonNull,
          source: { provider: input.provider ?? 'GREENHOUSE', step: result.step },
          orderIndex,
        },
      });
      if (!result.filledFieldIds.includes(field.id) || !assessment.profileKey) continue;
      await tx.applicationAnswer.upsert({
        where: { questionId: question.id },
        update: {
          value: { profileKey: assessment.profileKey },
          provenance: { source: 'USER_PROFILE', profileKey: assessment.profileKey, profileVersion },
          approved: true,
          approvedAt: undefined,
        },
        create: {
          userId: input.userId,
          applicationId: application.id,
          questionId: question.id,
          value: { profileKey: assessment.profileKey },
          provenance: { source: 'USER_PROFILE', profileKey: assessment.profileKey, profileVersion },
          approved: true,
          approvedAt: undefined,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: `${input.provider ?? 'GREENHOUSE'}_FORM_STEP_ASSESSED`,
        resource: 'Application',
        resourceId: application.id,
        details: {
          step: result.step,
          filledFieldIds: result.filledFieldIds,
          requiredBlockingFieldIds: result.requiredBlockingFieldIds,
          validationErrors: result.validationErrors,
        },
      },
    });
  });
}

async function recordReviewRequired(input: ExecuteGreenhouseApplicationInput, result: GreenhouseFillResult): Promise<void> {
  await withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
    if (!application) throw new GreenhouseApplicationError('NOT_FOUND', 'Application not found');
    const provider = input.provider ?? 'GREENHOUSE';
    const idempotencyKey = `${provider.toLowerCase()}-review-required:${input.idempotencyKey}`;
    const existing = await tx.outboxEvent.findUnique({ where: { idempotencyKey } });
    if (existing) return;
    await Promise.all([
      tx.notification.create({ data: {
        userId: input.userId,
        type: 'APPLICATION_REVIEW_REQUIRED',
        title: 'Application needs review',
        message: `${provider} form completion paused because it contains a required field that cannot be safely automated.`,
        data: { applicationId: application.id, step: result.step, requiredBlockingFieldIds: result.requiredBlockingFieldIds, validationErrors: result.validationErrors },
      } }),
      tx.outboxEvent.create({ data: {
        userId: input.userId,
        aggregateType: 'Application',
        aggregateId: application.id,
        eventType: 'application.review-required',
        payload: { provider, step: result.step, requiredBlockingFieldIds: result.requiredBlockingFieldIds, validationErrors: result.validationErrors },
        schemaVersion: 1,
        correlationId: input.correlationId,
        idempotencyKey,
      } }),
    ]);
  });
}

async function markFormFilled(input: ExecuteGreenhouseApplicationInput): Promise<void> {
  await withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
    if (!application) throw new GreenhouseApplicationError('NOT_FOUND', 'Application not found');
    if (application.status === 'FORM_FILLED') return;
    await transitionApplicationInTenant(tx, {
      applicationId: application.id,
      userId: input.userId,
      toStatus: 'FORM_FILLED',
      expectedVersion: application.version,
      actorType: 'WORKER',
      reason: `${input.provider ?? 'GREENHOUSE'} form fields were safely completed and validated`,
      idempotencyKey: `${(input.provider ?? 'GREENHOUSE').toLowerCase()}-form-filled:${input.idempotencyKey}`,
      correlationId: input.correlationId,
      metadata: { provider: input.provider ?? 'GREENHOUSE' },
    });
  });
}

export class GreenhouseApplicationService {
  constructor(
    private readonly browserSessions: BrowserSessionPort = new BrowserSessionManager(),
    private readonly formPort: FormPortFactory = page => new GreenhousePlaywrightFormPort(page),
  ) {}

  async execute(input: ExecuteGreenhouseApplicationInput): Promise<{ outcome: GreenhouseApplicationOutcome }> {
    requireText(input.userId, 'userId');
    requireText(input.applicationId, 'applicationId');
    requireText(input.workerId, 'workerId');
    requireText(input.correlationId, 'correlationId');
    requireText(input.idempotencyKey, 'idempotencyKey');
    const prepared = await loadPreparedApplication(input);
    if (prepared.status === 'FORM_FILLED') return { outcome: 'FORM_FILLED' };
    const provider = input.provider ?? 'GREENHOUSE';
    const host = providerHost(prepared.targetUrl, provider);
    const sessionKey = `${provider.toLowerCase()}-browser:${input.idempotencyKey}`;
    const started = await this.browserSessions.start({
      userId: input.userId,
      applicationId: input.applicationId,
      targetUrl: prepared.targetUrl,
      allowedHosts: [host],
      workerId: input.workerId,
      correlationId: input.correlationId,
      idempotencyKey: sessionKey,
      expiresAt: new Date(Date.now() + sessionLifetimeMs),
    });

    try {
      const results = await this.browserSessions.withPage(input.userId, started.session.externalRef, async page => {
        const port = this.formPort(page);
        const adapter = new GreenhouseApplicationAdapter();
        const completed = [await adapter.fillCurrentStep(port, prepared.profile)];
        for (let step = 1; completed.at(-1)!.advanced && step < maxFormSteps; step += 1) {
          completed.push(await adapter.fillCurrentStep(port, prepared.profile));
        }
        const current = completed.at(-1)!;
        if (current.advanced) throw new GreenhouseApplicationError('CONFLICT', `${provider} form exceeded the safe step limit`);
        return completed;
      });
      const result = results.at(-1)!;
      for (const completed of results) await persistFormResult(input, completed, prepared.profileVersion);
      const verification = verificationAssessment(result);
      if (verification?.verification) {
        await requestHumanVerification({
          userId: input.userId,
          applicationId: input.applicationId,
          type: verification.verification,
          prompt: `Complete the required verification in the ${provider} application, then acknowledge completion to resume safely.`,
          context: { provider, fieldId: verification.fieldId, step: result.step },
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          correlationId: input.correlationId,
          idempotencyKey: `${provider.toLowerCase()}-verification:${input.idempotencyKey}:${verification.fieldId}`,
        });
        return { outcome: 'HUMAN_VERIFICATION_REQUIRED' };
      }
      if (needsReview(result)) {
        await recordReviewRequired(input, result);
        return { outcome: 'REVIEW_REQUIRED' };
      }
      await markFormFilled(input);
      return { outcome: 'FORM_FILLED' };
    } finally {
      await this.browserSessions.close(input.userId, started.session.externalRef, input.correlationId);
    }
  }
}
