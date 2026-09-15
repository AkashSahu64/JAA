import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import {
  GreenhouseApplicationAdapter,
  LeverApplicationAdapter,
  greenhouseApplicationHost,
  leverApplicationHost,
  stableQuestionIdentity,
  type ApprovedGreenhouseProfile,
  type ApplicationFormAssessment,
  type ApprovedApplicationAnswer,
  type GreenhouseFillResult,
  type GreenhouseFormPort,
  type LeverFormPort,
} from '@jobagent/job-engine';
import type { Page } from 'playwright';
import {
  BrowserSessionManager,
  type StartBrowserSessionInput,
} from './browser-session-manager';
import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';
import { requestHumanVerification } from './human-verification';
import { transitionApplicationInTenant } from './application-state-machine';
import { DocumentStorage } from './document-storage';
import { selectReviewedApplicationAnswer } from './submission-engine';

const maxFormSteps = 10;
const sessionLifetimeMs = 15 * 60 * 1000;

type BrowserSessionPort = {
  start(input: StartBrowserSessionInput): Promise<{ session: { externalRef: string }; replayed: boolean }>;
  withPage<T>(userId: string, externalRef: string, operation: (page: Page) => Promise<T>): Promise<T>;
  close(userId: string, externalRef: string, correlationId: string): Promise<void>;
};

type FormPortFactory = (page: Page) => GreenhouseFormPort | LeverFormPort;
type ApprovedResumeDocument = {
  id: string;
  userId: string;
  kind: string;
  resumeVersionId: string | null;
  bucket: string;
  objectKey: string;
  versionId: string | null;
  fileName: string;
  mimeType: string;
  checksumSha256: string;
  byteSize: bigint;
  encryptionKeyRef?: string | null;
  approvalStatus?: string;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  scanStatus: string;
  deletedAt: Date | null;
  expiresAt: Date | null;
};

type PreparedApplication = {
  targetUrl: string;
  profile: ApprovedGreenhouseProfile;
  profileVersion: number;
  status: string;
  resumeVersionId: string;
  coverLetter: string | undefined;
  document: ApprovedResumeDocument | null;
  coverLetterDocument: ApprovedResumeDocument | null;
  approvedAnswers: readonly ApprovedApplicationAnswer[];
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

export type ExecuteProviderApplicationInput = ExecuteGreenhouseApplicationInput;

export type GreenhouseApplicationOutcome = 'FORM_FILLED' | 'REVIEW_REQUIRED' | 'HUMAN_VERIFICATION_REQUIRED';
/** Provider-neutral outcome contract retained here for backwards compatibility. */
export type ProviderApplicationOutcome = GreenhouseApplicationOutcome;

export class GreenhouseApplicationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'GreenhouseApplicationError';
  }
}

/** Provider-neutral error alias; Greenhouse imports remain supported. */
export { GreenhouseApplicationError as ProviderApplicationError };

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
  const host = provider === 'GREENHOUSE' ? greenhouseApplicationHost(targetUrl) : leverApplicationHost(targetUrl);
  if (!host) {
    throw new GreenhouseApplicationError('INVALID', `Application URL is not a ${provider} HTTPS host`);
  }
  return host;
}

async function loadPreparedApplication(input: ExecuteGreenhouseApplicationInput): Promise<PreparedApplication> {
  return withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({
      where: { id: input.applicationId, userId: input.userId },
      include: {
        job: { select: { applicationUrl: true } },
        coverLetter: { select: { content: true } },
        documents: { where: { type: 'cover_letter' }, include: { objectMetadata: true } },
        questionsNormalized: { include: { answers: true } },
        resumeVersion: { include: { objectMetadata: true, resume: { include: { objectMetadata: true } } } },
      },
    });
    const profile = await tx.userProfile.findUnique({ where: { userId: input.userId } });
    if (!application || !profile) throw new GreenhouseApplicationError('NOT_FOUND', 'Application or user profile not found');
    const approvedAnswers: ApprovedApplicationAnswer[] = [];
    for (const question of application.questionsNormalized) {
      const answer = selectReviewedApplicationAnswer(question.answers, input.userId);
      if (!answer || !question.externalKey || !answer.source || !answer.provenance || typeof answer.provenance !== 'object' || Array.isArray(answer.provenance)) continue;
      const provenance = answer.provenance as Record<string, unknown>;
      const source = answer.source;
      if (provenance.source !== source) continue;
      if (source !== 'USER_PROFILE' && source !== 'USER_INPUT' && source !== 'COVER_LETTER' && source !== 'AI_SUGGESTION') continue;
      const value = answer.value;
      if (typeof value !== 'string' && typeof value !== 'boolean' && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) continue;
      approvedAnswers.push({
        answerId: answer.id,
        questionIdentity: question.externalKey,
        ownerId: answer.userId,
        value,
        source,
        approved: answer.approved,
        approvedAt: answer.approvedAt ?? undefined,
        approvedBy: answer.approvedBy ?? undefined,
        provenance,
        version: answer.version,
      });
    }
    const coverLetterDocuments = application.documents ?? [];
    if (coverLetterDocuments.length > 1) throw new GreenhouseApplicationError('CONFLICT', 'Application has ambiguous cover-letter document attachments');
    const coverLetterDocument = coverLetterDocuments[0]?.objectMetadata ?? null;
    if (application.resumeVersion.objectMetadata
      && (application.resumeVersion.objectMetadata.approvalStatus !== undefined
        && (application.resumeVersion.objectMetadata.approvalStatus !== 'APPROVED'
          || !application.resumeVersion.objectMetadata.approvedAt
          || application.resumeVersion.objectMetadata.approvedBy !== input.userId))) {
      throw new GreenhouseApplicationError('CONFLICT', 'The exact resume document has not been approved by the authenticated owner');
    }
    if (coverLetterDocument
      && (coverLetterDocument.approvalStatus !== undefined
        && (coverLetterDocument.approvalStatus !== 'APPROVED'
          || !coverLetterDocument.approvedAt
          || coverLetterDocument.approvedBy !== input.userId))) {
      throw new GreenhouseApplicationError('CONFLICT', 'The exact cover-letter document has not been approved by the authenticated owner');
    }
    const prepared = {
      targetUrl: application.job.applicationUrl,
      profile: approvedGreenhouseProfile(profile),
      profileVersion: profile.version,
      status: application.status,
      resumeVersionId: application.resumeVersionId,
      coverLetter: application.coverLetter?.content?.trim() || undefined,
      // Browser workers may submit only the immutable object attached to the
      // selected ResumeVersion; a master-resume fallback would make the
      // application reference mutable after authorization.
      document: application.resumeVersion.objectMetadata,
      coverLetterDocument,
      approvedAnswers,
    };
    if (application.status === 'FORM_FILLED') return prepared;
    if (application.status !== 'APPLICATION_STARTED') {
      throw new GreenhouseApplicationError('CONFLICT', 'Application is not ready for Greenhouse form completion');
    }
    return prepared;
  });
}

function assessmentFor(result: GreenhouseFillResult, fieldId: string): ApplicationFormAssessment | undefined {
  return result.assessments.find(assessment => assessment.fieldId === fieldId);
}

function verificationAssessment(result: GreenhouseFillResult): ApplicationFormAssessment | undefined {
  return result.assessments.find(assessment => assessment.disposition === 'HUMAN_VERIFICATION_REQUIRED'
    && !result.filledFieldIds.includes(assessment.fieldId));
}

function supplementaryTextFields(result: GreenhouseFillResult, coverLetter: string | undefined): string[] {
  if (!coverLetter) return [];
  return result.fields
    .filter(field => field.kind === 'TEXTAREA' && isCoverLetterField(field))
    .map(field => field.id);
}

function resumeDocumentFields(result: GreenhouseFillResult): string[] {
  return result.fields
    .filter(field => field.kind === 'FILE' && /resume|cv/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`))
    .map(field => field.id);
}

export async function fillApprovedResumeDocument(
  port: GreenhouseFormPort,
  result: GreenhouseFillResult,
  document: ApprovedResumeDocument | null,
  expectedResumeVersionId: string,
  ownerId: string,
  storage: Pick<DocumentStorage, 'readAuthorized'>,
): Promise<GreenhouseFillResult> {
  const fieldIds = resumeDocumentFields(result);
  if (!fieldIds.length || !document || !port.uploadDocument) return result;
  if (fieldIds.length !== 1) {
    return { ...result, requiredBlockingFieldIds: [...new Set([...result.requiredBlockingFieldIds, ...fieldIds])] };
  }
  if (document.userId !== ownerId
    || !['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'].includes(document.kind)
    || (document.approvalStatus !== undefined && document.approvalStatus !== 'APPROVED')
    || (document.approvalStatus === 'APPROVED' && (!document.approvedAt || document.approvedBy !== ownerId))
    || document.scanStatus !== 'CLEAN' || document.deletedAt || (document.expiresAt && document.expiresAt <= new Date())
    || document.resumeVersionId !== expectedResumeVersionId) {
    return result;
  }
  const file = await storage.readAuthorized(ownerId, document);
  await Promise.all(fieldIds.map(fieldId => port.uploadDocument!(fieldId, {
    fileName: file.fileName, mimeType: file.mimeType, checksumSha256: document.checksumSha256, bytes: file.buffer,
  })));
  const validationErrors = await port.validate();
  return {
    ...result,
    filledFieldIds: [...new Set([...result.filledFieldIds, ...fieldIds])],
    requiredBlockingFieldIds: result.requiredBlockingFieldIds.filter(fieldId => !fieldIds.includes(fieldId)),
    validationErrors,
  };
}

export async function fillApprovedCoverLetterDocument(
  port: GreenhouseFormPort,
  result: GreenhouseFillResult,
  document: ApprovedResumeDocument | null,
  ownerId: string,
  storage: Pick<DocumentStorage, 'readAuthorized'>,
  expectedResumeVersionId?: string,
): Promise<GreenhouseFillResult> {
  const fieldIds = result.fields
    .filter(field => field.kind === 'FILE' && isCoverLetterField(field))
    .map(field => field.id);
  if (!fieldIds.length || !document || !port.uploadDocument) return result;
  if (fieldIds.length !== 1) {
    return { ...result, requiredBlockingFieldIds: [...new Set([...result.requiredBlockingFieldIds, ...fieldIds])] };
  }
  if (document.userId !== ownerId || (expectedResumeVersionId !== undefined && document.resumeVersionId !== expectedResumeVersionId)
    || document.kind !== 'COVER_LETTER' || (document.approvalStatus !== undefined && document.approvalStatus !== 'APPROVED')
    || (document.approvalStatus === 'APPROVED' && (!document.approvedAt || document.approvedBy !== ownerId))
    || document.scanStatus !== 'CLEAN' || document.deletedAt
    || (document.expiresAt && document.expiresAt <= new Date())) return result;
  const file = await storage.readAuthorized(ownerId, document);
  await Promise.all(fieldIds.map(fieldId => port.uploadDocument!(fieldId, {
    fileName: file.fileName, mimeType: file.mimeType, checksumSha256: document.checksumSha256, bytes: file.buffer,
  })));
  const validationErrors = await port.validate();
  return {
    ...result,
    filledFieldIds: [...new Set([...result.filledFieldIds, ...fieldIds])],
    requiredBlockingFieldIds: result.requiredBlockingFieldIds.filter(fieldId => !fieldIds.includes(fieldId)),
    validationErrors,
  };
}

export async function fillSupplementaryText(
  port: GreenhouseFormPort,
  result: GreenhouseFillResult,
  coverLetter: string | undefined,
): Promise<GreenhouseFillResult> {
  const fieldIds = supplementaryTextFields(result, coverLetter);
  if (!fieldIds.length || !coverLetter) return result;
  if (fieldIds.length !== 1) {
    return { ...result, requiredBlockingFieldIds: [...new Set([...result.requiredBlockingFieldIds, ...fieldIds])] };
  }
  await Promise.all(fieldIds.map(fieldId => port.fill(fieldId, coverLetter)));
  const validationErrors = await port.validate();
  const requiredBlockingFieldIds = result.requiredBlockingFieldIds.filter(fieldId => !fieldIds.includes(fieldId));
  return { ...result, filledFieldIds: [...new Set([...result.filledFieldIds, ...fieldIds])], requiredBlockingFieldIds, validationErrors };
}

function isCoverLetterField(field: { name: string; label: string; accessibleName?: string; kind: string }): boolean {
  return /cover[ _-]?letter/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`);
}

function requiresStoredDocument(field: { name: string; label: string; accessibleName?: string; kind: string }): boolean {
  return field.kind === 'FILE' && (/resume|cv|cover[ _-]?letter/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`));
}

function evidenceFor(
  result: GreenhouseFillResult,
  resumeVersionId: string,
  document?: { id: string; checksumSha256: string; kind: string; resumeVersionId: string | null; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; byteSize: bigint; encryptionKeyRef?: string | null; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null; scanStatus: string } | null,
  coverLetterDocument?: { id: string; checksumSha256: string; kind: string; resumeVersionId: string | null; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; byteSize: bigint; encryptionKeyRef?: string | null; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null; scanStatus: string } | null,
): Record<string, unknown> {
  return {
    step: result.step,
    fieldsDetected: result.fields.length,
    fieldsFilled: result.filledFieldIds,
    requiredBlockingFieldIds: result.requiredBlockingFieldIds,
    validationErrors: result.validationErrors,
    resumeVersionId,
    resumeDocument: document ? {
      objectMetadataId: document.id,
      checksumSha256: document.checksumSha256,
      kind: document.kind,
      bucket: document.bucket,
      objectKey: document.objectKey,
      versionId: document.versionId,
      fileName: document.fileName,
      mimeType: document.mimeType,
      byteSize: document.byteSize.toString(),
      encryptionKeyRef: document.encryptionKeyRef,
      approvalStatus: document.approvalStatus,
      approvedAt: document.approvedAt?.toISOString() ?? null,
      approvedBy: document.approvedBy,
      scanStatus: document.scanStatus,
      resumeVersionId: document.resumeVersionId,
    } : null,
    coverLetterDocument: coverLetterDocument ? {
      objectMetadataId: coverLetterDocument.id,
      checksumSha256: coverLetterDocument.checksumSha256,
      kind: coverLetterDocument.kind,
      resumeVersionId: coverLetterDocument.resumeVersionId,
      bucket: coverLetterDocument.bucket,
      objectKey: coverLetterDocument.objectKey,
      versionId: coverLetterDocument.versionId,
      fileName: coverLetterDocument.fileName,
      mimeType: coverLetterDocument.mimeType,
      byteSize: coverLetterDocument.byteSize.toString(),
      encryptionKeyRef: coverLetterDocument.encryptionKeyRef,
      approvalStatus: coverLetterDocument.approvalStatus,
      approvedAt: coverLetterDocument.approvedAt?.toISOString() ?? null,
      approvedBy: coverLetterDocument.approvedBy,
      scanStatus: coverLetterDocument.scanStatus,
    } : null,
    documentUploadFieldsDeferred: result.fields.filter(requiresStoredDocument).map(field => field.id),
  };
}

function requiredBlockingFields(result: GreenhouseFillResult, coverLetter: string | undefined): string[] {
  return result.requiredBlockingFieldIds.filter(fieldId => {
    const field = result.fields.find(candidate => candidate.id === fieldId);
    if (!field) return true;
    return !(isCoverLetterField(field) && field.kind === 'TEXTAREA' && coverLetter);
  });
}

function needsReview(result: GreenhouseFillResult, coverLetter: string | undefined): boolean {
  return result.validationErrors.length > 0
    || requiredBlockingFields(result, coverLetter).length > 0
    || result.assessments.some(assessment => ['AMBIGUOUS', 'SENSITIVE', 'HIGH_RISK'].includes(assessment.disposition)
      && !result.filledFieldIds.includes(assessment.fieldId));
}

async function persistFormResult(
  input: ExecuteGreenhouseApplicationInput,
  result: GreenhouseFillResult,
  profileVersion: number,
  coverLetter: string | undefined,
  resumeVersionId: string,
  document?: Parameters<typeof evidenceFor>[2],
  coverLetterDocument?: Parameters<typeof evidenceFor>[3],
  approvedAnswers: readonly ApprovedApplicationAnswer[] = [],
): Promise<void> {
  await withTenant(input.userId, async tx => {
    const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId } });
    if (!application) throw new GreenhouseApplicationError('NOT_FOUND', 'Application not found');
    const persistedAnswers: Array<Record<string, unknown>> = [];
    for (const [orderIndex, field] of result.fields.entries()) {
      const assessment = assessmentFor(result, field.id);
      if (!assessment) continue;
      const questionIdentity = field.identity ?? stableQuestionIdentity(input.provider ?? 'GREENHOUSE', field, result.stepIdentity);
      const question = await tx.applicationQuestion.upsert({
        where: { applicationId_externalKey: { applicationId: application.id, externalKey: questionIdentity } },
        update: {
          label: field.label,
          normalizedKey: field.name,
          fieldType: field.kind,
          required: field.required,
          risk: assessment.disposition,
          options: field.options ? field.options as Prisma.InputJsonValue : Prisma.JsonNull,
          source: { provider: input.provider ?? 'GREENHOUSE', step: result.step, stepIdentity: result.stepIdentity, fieldId: field.id },
          orderIndex,
        },
        create: {
          userId: input.userId,
          applicationId: application.id,
          externalKey: questionIdentity,
          label: field.label,
          normalizedKey: field.name,
          fieldType: field.kind,
          required: field.required,
          risk: assessment.disposition,
          options: field.options ? field.options as Prisma.InputJsonValue : Prisma.JsonNull,
          source: { provider: input.provider ?? 'GREENHOUSE', step: result.step, stepIdentity: result.stepIdentity, fieldId: field.id },
          orderIndex,
        },
      });
      const isSupplementaryCoverLetter = Boolean(
        coverLetter && isCoverLetterField(field) && field.kind === 'TEXTAREA' && result.filledFieldIds.includes(field.id),
      );
      if (!result.filledFieldIds.includes(field.id)) continue;
      if (!assessment.profileKey && !isSupplementaryCoverLetter) {
        const approved = approvedAnswers.find(answer => answer.questionIdentity === questionIdentity && answer.ownerId === input.userId);
        if (approved) persistedAnswers.push({
          answerId: approved.answerId,
          questionIdentity,
          ownerId: approved.ownerId,
          source: approved.source,
          provenance: approved.provenance ?? {},
          approved: approved.approved,
          approvedAt: approved.approvedAt?.toISOString() ?? null,
          version: approved.version,
        });
        continue;
      }
      const answerSource = isSupplementaryCoverLetter
        ? { source: 'COVER_LETTER', resumeVersionId }
        : { source: 'USER_PROFILE', profileKey: assessment.profileKey!, profileVersion };
      const value = isSupplementaryCoverLetter ? { source: 'coverLetter' } : { profileKey: assessment.profileKey! };
      const existingAnswer = await tx.applicationAnswer.findUnique({ where: { questionId: question.id } });
      const unchanged = existingAnswer?.userId === input.userId
        && existingAnswer.approved
        && existingAnswer.approvedBy === input.userId
        && JSON.stringify(existingAnswer.value) === JSON.stringify(value)
        && JSON.stringify(existingAnswer.provenance) === JSON.stringify(answerSource);
      const answer = unchanged
        ? existingAnswer
        : await (async () => {
          // Use one timestamp for both fields: the database approval
          // invariant requires approvedAt >= createdAt, and separate client
          // and server-default clocks can otherwise invert them by millis.
          const approvalTimestamp = new Date();
          return tx.applicationAnswer.upsert({
            where: { questionId: question.id },
            update: {
              value,
              source: answerSource.source,
              provenance: answerSource,
              approved: true,
              approvedAt: approvalTimestamp,
              approvedBy: input.userId,
              version: { increment: 1 },
            },
            create: {
              userId: input.userId,
              applicationId: application.id,
              questionId: question.id,
              value,
              source: answerSource.source,
              provenance: answerSource,
              approved: true,
              createdAt: approvalTimestamp,
              approvedAt: approvalTimestamp,
              approvedBy: input.userId,
            },
          });
        })();
      persistedAnswers.push({
        answerId: answer.id,
        questionIdentity,
        ownerId: input.userId,
        source: answerSource.source,
        provenance: answerSource,
        approved: answer.approved,
        approvedAt: answer.approvedAt?.toISOString() ?? null,
        version: answer.version,
      });
    }
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: `${input.provider ?? 'GREENHOUSE'}_FORM_STEP_ASSESSED`,
        resource: 'Application',
        resourceId: application.id,
        details: { ...evidenceFor(result, resumeVersionId, document, coverLetterDocument), persistedAnswers } as Prisma.InputJsonValue,
      },
    });
  });
}

async function recordReviewRequired(
  input: ExecuteGreenhouseApplicationInput,
  result: GreenhouseFillResult,
  coverLetter: string | undefined,
): Promise<void> {
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
        data: { applicationId: application.id, step: result.step, requiredBlockingFieldIds: requiredBlockingFields(result, coverLetter), validationErrors: result.validationErrors },
      } }),
      tx.outboxEvent.create({ data: {
        userId: input.userId,
        aggregateType: 'Application',
        aggregateId: application.id,
        eventType: 'application.review-required',
        payload: { provider, step: result.step, requiredBlockingFieldIds: requiredBlockingFields(result, coverLetter), validationErrors: result.validationErrors },
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

/** Shared provider orchestration. Provider adapters supply their own form port and host policy. */
export class ProviderApplicationService {
  constructor(
    private readonly browserSessions: BrowserSessionPort = new BrowserSessionManager(),
    private readonly formPort: FormPortFactory = page => new GreenhousePlaywrightFormPort(page),
    private readonly documentStorage: Pick<DocumentStorage, 'readAuthorized'> = new DocumentStorage(),
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
        const completed: GreenhouseFillResult[] = [];
        for (let step = 0; step < maxFormSteps; step += 1) {
          const initial = provider === 'LEVER'
            ? await new LeverApplicationAdapter().fillCurrentStep(port as LeverFormPort, prepared.profile, prepared.approvedAnswers, input.userId)
            : await new GreenhouseApplicationAdapter().fillCurrentStep(port as GreenhouseFormPort, prepared.profile, prepared.approvedAnswers, input.userId);
          const greenhousePort = port as GreenhouseFormPort;
          const withDocument = await fillApprovedResumeDocument(greenhousePort, initial, prepared.document, prepared.resumeVersionId, input.userId, this.documentStorage);
          const withCoverLetterDocument = await fillApprovedCoverLetterDocument(greenhousePort, withDocument, prepared.coverLetterDocument, input.userId, this.documentStorage, prepared.resumeVersionId);
          const result = await fillSupplementaryText(greenhousePort, withCoverLetterDocument, prepared.coverLetter);
          completed.push(result);
          if (!result.hasNextStep || needsReview(result, prepared.coverLetter)) break;
          if (!result.advanced) break;
        }
        if (completed.at(-1)?.hasNextStep && (
          completed.at(-1)!.advanced || !needsReview(completed.at(-1)!, prepared.coverLetter)
        ) && completed.length === maxFormSteps) {
          throw new GreenhouseApplicationError('CONFLICT', `${provider} form exceeded the safe step limit`);
        }
        return completed;
      });
      const result = results.at(-1)!;
      for (const completed of results) {
        await persistFormResult(input, completed, prepared.profileVersion, prepared.coverLetter, prepared.resumeVersionId, prepared.document, prepared.coverLetterDocument, prepared.approvedAnswers);
      }
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
      if (needsReview(result, prepared.coverLetter)) {
        await recordReviewRequired(input, result, prepared.coverLetter);
        return { outcome: 'REVIEW_REQUIRED' };
      }
      await markFormFilled(input);
      return { outcome: 'FORM_FILLED' };
    } finally {
      await this.browserSessions.close(input.userId, started.session.externalRef, input.correlationId);
    }
  }
}

/** Backward-compatible Greenhouse entry point; provider-specific DOM behavior stays in its port. */
export { ProviderApplicationService as GreenhouseApplicationService };
