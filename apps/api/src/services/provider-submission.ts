import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { advanceStepIfComplete, greenhouseApplicationHost, GreenhouseApplicationAdapter, leverApplicationHost, LeverApplicationAdapter, type ApprovedApplicationAnswer, type GreenhouseFormPort, type LeverFormPort } from '@jobagent/job-engine';
import type { Page } from 'playwright';
import { BrowserSessionManager, type StartBrowserSessionInput } from './browser-session-manager';
import { DocumentStorage, DocumentStorageError, validateStoredDocumentMetadata } from './document-storage';
import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';
import { LeverPlaywrightFormPort } from './lever-form-port';
import { parseProviderConfirmation, SubmissionVerificationError, type SubmissionVerificationEvidence } from './submission-verification';
import { requestHumanVerification } from './human-verification';

const sessionLifetimeMs = 10 * 60 * 1000;
const maxSubmissionSteps = 10;

type Provider = 'GREENHOUSE' | 'LEVER';
type FormPortFactory = (page: Page) => GreenhouseFormPort | LeverFormPort;
type BrowserSessionPort = Pick<BrowserSessionManager, 'start' | 'withPage' | 'close'>;
type DocumentStoragePort = Pick<DocumentStorage, 'readAuthorized'>;
type HumanVerificationRequester = (input: Parameters<typeof requestHumanVerification>[0]) => Promise<unknown>;

export class ProviderSubmissionError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'HUMAN_VERIFICATION_REQUIRED' | 'UNKNOWN_OUTCOME', message: string) {
    super(message);
    this.name = 'ProviderSubmissionError';
  }
}

function requireSubmissionText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ProviderSubmissionError('INVALID', `${name} is required and must be bounded and free of control characters`);
  }
}

export interface ExecuteProviderSubmissionInput {
  userId: string;
  applicationId: string;
  authorizationId: string;
  correlationId: string;
  workerId: string;
}

type PreparedSubmission = {
  provider: Provider;
  targetUrl: string;
  allowedHost: string;
  profile: { firstName?: string; lastName?: string; email?: string; phone?: string; location?: string; linkedinUrl?: string; websiteUrl?: string };
  approvedAnswers: ApprovedApplicationAnswer[];
  coverLetter?: string;
  document: { bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint };
  coverLetterDocument?: { userId: string; resumeVersionId: string | null; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; scanStatus: string; deletedAt: Date | null; expiresAt: Date | null };
};

function approvedAnswersFor(
  questions: Array<{ externalKey: string | null; answers: Array<{ id: string; userId: string; value: Prisma.JsonValue; source: string; approved: boolean; approvedAt: Date | null; approvedBy: string | null; provenance: Prisma.JsonValue; version: number }> }>,
  ownerId: string,
  coverLetterContent?: string,
): ApprovedApplicationAnswer[] {
  const answers: ApprovedApplicationAnswer[] = [];
  for (const question of questions) for (const answer of question.answers) {
    if (!question.externalKey) continue;
    const value = answer.value;
    const rawProvenance = answer.provenance;
    const rawSource = rawProvenance && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance) ? (rawProvenance as Record<string, unknown>).source : undefined;
    const resolvedValue = rawSource === 'COVER_LETTER' && value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).source === 'coverLetter' && coverLetterContent?.trim() ? coverLetterContent.trim() : value;
    if (!answer.approved || !answer.approvedAt || answer.approvedBy !== ownerId || answer.userId !== ownerId
      || (typeof resolvedValue !== 'string' && typeof resolvedValue !== 'boolean' && !(Array.isArray(resolvedValue) && resolvedValue.every(item => typeof item === 'string')))
      || !answer.provenance || typeof answer.provenance !== 'object' || Array.isArray(answer.provenance)) continue;
    const provenance = answer.provenance as Record<string, unknown>;
    const source = answer.source;
    if (provenance.source !== source) continue;
    if (source !== 'USER_PROFILE' && source !== 'USER_INPUT' && source !== 'COVER_LETTER' && source !== 'AI_SUGGESTION') continue;
    // Profile-derived values are supplied from the authenticated profile below;
    // a scalar USER_PROFILE answer is never a valid custom-answer payload.
    if (source === 'USER_PROFILE') continue;
    answers.push({ answerId: answer.id, questionIdentity: question.externalKey, ownerId, value: resolvedValue, source, approved: true, approvedAt: answer.approvedAt, approvedBy: answer.approvedBy, provenance, version: answer.version });
  }
  return answers;
}

function providerFor(source: string): Provider {
  const normalized = source.trim().toUpperCase();
  if (normalized === 'GREENHOUSE' || normalized === 'LEVER') return normalized;
  throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application source has no certified submission adapter');
}

function providerHost(url: string, provider: Provider): string {
  const host = provider === 'GREENHOUSE' ? greenhouseApplicationHost(url) : leverApplicationHost(url);
  if (!host) {
    throw new ProviderSubmissionError('PRECONDITION_FAILED', `Application URL is not a ${provider} HTTPS host`);
  }
  return host;
}

function profileFor(profile: { fullName: string; email: string; phone: string | null; locationCity: string | null; locationState: string | null; locationCountry: string | null; linkedIn: string | null; portfolio: string | null }) {
  const [firstName, ...lastName] = profile.fullName.trim().split(/\s+/);
  const location = [profile.locationCity, profile.locationState, profile.locationCountry].filter((value): value is string => Boolean(value?.trim())).join(', ');
  return { firstName, lastName: lastName.join(' ') || undefined, email: profile.email, phone: profile.phone ?? undefined, location: location || undefined, linkedinUrl: profile.linkedIn ?? undefined, websiteUrl: profile.portfolio ?? undefined };
}

function evidenceMatches(
  authorization: { applicationVersion: number; resumeVersionId: string; preflightEvidence: Prisma.JsonValue },
  application: { version: number; resumeVersionId: string; resumeVersion: { objectMetadata: { id: string; resumeVersionId: string | null; kind: string; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; byteSize: bigint; checksumSha256: string; encryptionKeyRef: string | null; scanStatus: string; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null } | null }; documents?: Array<{ objectMetadata: { id: string; resumeVersionId: string | null; kind: string; bucket: string; objectKey: string; versionId: string | null; fileName: string; mimeType: string; byteSize: bigint; checksumSha256: string; encryptionKeyRef: string | null; scanStatus: string; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null } | null }> },
): boolean {
  if (application.version !== authorization.applicationVersion + 1 || application.resumeVersionId !== authorization.resumeVersionId) return false;
  if (!authorization.preflightEvidence || typeof authorization.preflightEvidence !== 'object' || Array.isArray(authorization.preflightEvidence)) return false;
  const evidence = authorization.preflightEvidence as Record<string, unknown>;
  const recorded = evidence.resumeDocument;
  const document = application.resumeVersion.objectMetadata;
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded) || !document) return false;
  const reference = recorded as Record<string, unknown>;
  const sameApproval = (candidate: Record<string, unknown>, current: { approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null }) => {
    const approvedAt = current.approvedAt instanceof Date && Number.isFinite(current.approvedAt.getTime())
      ? current.approvedAt.toISOString() : null;
    return (candidate.approvalStatus ?? null) === (current.approvalStatus ?? null)
      && (candidate.approvedAt ?? null) === approvedAt
      && (candidate.approvedBy ?? null) === (current.approvedBy ?? null);
  };
  const sameDocument = (candidate: Record<string, unknown>, current: NonNullable<typeof document>) => candidate.id === current.id
    && candidate.kind === current.kind && candidate.resumeVersionId === current.resumeVersionId && candidate.bucket === current.bucket && candidate.objectKey === current.objectKey
    && (candidate.versionId ?? null) === (current.versionId ?? null) && candidate.fileName === current.fileName
    && candidate.mimeType === current.mimeType && String(candidate.byteSize) === current.byteSize.toString()
    && candidate.checksumSha256 === current.checksumSha256 && candidate.encryptionKeyRef === current.encryptionKeyRef
    && candidate.scanStatus === current.scanStatus && sameApproval(candidate, current);
  const recordedCover = evidence.coverLetterDocument;
  const currentCover = (application.documents ?? []).map(item => item.objectMetadata).filter((item): item is NonNullable<typeof document> & { resumeVersionId: string | null } => Boolean(item));
  const coverMatches = recordedCover === null || recordedCover === undefined
    ? currentCover.length === 0
    : currentCover.length === 1 && typeof recordedCover === 'object' && !Array.isArray(recordedCover) && sameDocument(recordedCover as Record<string, unknown>, currentCover[0]!);
  return evidence.resumeVersionId === application.resumeVersionId
    && reference.id === document.id
    && reference.kind === document.kind
    && reference.bucket === document.bucket
    && reference.objectKey === document.objectKey
    && (reference.versionId ?? null) === (document.versionId ?? null)
    && reference.fileName === document.fileName
    && reference.mimeType === document.mimeType
    && String(reference.byteSize) === document.byteSize.toString()
    && reference.checksumSha256 === document.checksumSha256
    && reference.encryptionKeyRef === document.encryptionKeyRef
    && reference.scanStatus === document.scanStatus
    && sameApproval(reference, document)
    && coverMatches;
}

export class ProviderSubmissionService {
  constructor(
    private readonly browserSessions: BrowserSessionPort = new BrowserSessionManager(),
    private readonly documentStorage: DocumentStoragePort = new DocumentStorage(),
    private readonly ports: Record<Provider, FormPortFactory> = {
      GREENHOUSE: page => new GreenhousePlaywrightFormPort(page),
      LEVER: page => new LeverPlaywrightFormPort(page),
    },
    private readonly requestVerification: HumanVerificationRequester = requestHumanVerification,
  ) {}

  async execute(input: ExecuteProviderSubmissionInput): Promise<{ provider: Provider; attemptedAt: Date; confirmation?: SubmissionVerificationEvidence }> {
    requireSubmissionText(input?.userId, 'userId');
    requireSubmissionText(input?.applicationId, 'applicationId');
    requireSubmissionText(input?.authorizationId, 'authorizationId');
    requireSubmissionText(input?.correlationId, 'correlationId');
    requireSubmissionText(input?.workerId, 'workerId');
    let attemptedAt: Date | undefined;
    const prepared = await withTenant(input.userId, async tx => {
      const authorization = await tx.submissionAuthorization.findFirst({
        where: { id: input.authorizationId, applicationId: input.applicationId, userId: input.userId, status: 'EXECUTING' },
        include: { application: { include: { job: true, documents: { where: { type: 'cover_letter' }, include: { objectMetadata: true } }, coverLetter: { select: { content: true, userId: true } }, questionsNormalized: { include: { answers: { where: { userId: input.userId, approved: true, approvedAt: { not: null }, approvedBy: input.userId }, select: { id: true, userId: true, value: true, source: true, approved: true, approvedAt: true, approvedBy: true, provenance: true, version: true } } } }, resumeVersion: { include: { objectMetadata: true, resume: { include: { objectMetadata: true } } } } } }, user: { include: { profile: true } } },
      });
      if (!authorization || !authorization.user.profile) throw new ProviderSubmissionError('NOT_FOUND', 'Authorized submission or candidate profile was not found');
      if (!evidenceMatches(authorization, authorization.application)) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'Application changed after final submission authorization');
      const document = authorization.application.resumeVersion.objectMetadata;
      const exactDocument = document?.resumeVersionId === authorization.application.resumeVersionId;
      const approvedResumeArtifact = document && ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'].includes(document.kind);
      if (!document || !exactDocument || !approvedResumeArtifact || document.userId !== input.userId
        || !document.objectKey.startsWith('private/') || !/^[a-f0-9]{64}$/i.test(document.checksumSha256)
        || document.approvalStatus !== 'APPROVED' || !(document.approvedAt instanceof Date) || !Number.isFinite(document.approvedAt.getTime()) || document.approvedBy !== input.userId
        || !document.encryptionKeyRef?.trim() || document.scanStatus !== 'CLEAN' || document.deletedAt || (document.expiresAt && document.expiresAt <= new Date())) {
        throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The authorized resume document is no longer available');
      }
      try {
        validateStoredDocumentMetadata(document, { userId: input.userId, kinds: ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'] });
      } catch (error) {
        if (error instanceof DocumentStorageError) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The authorized resume document metadata is invalid');
        throw error;
      }
      const coverLetterDocuments = authorization.application.documents ?? [];
      if (coverLetterDocuments.length > 1) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application has ambiguous cover-letter document attachments');
      const coverLetterDocument = coverLetterDocuments[0]?.objectMetadata;
      if (coverLetterDocument) {
        if (coverLetterDocument.userId !== input.userId || coverLetterDocument.resumeVersionId !== authorization.application.resumeVersionId || coverLetterDocument.kind !== 'COVER_LETTER'
          || coverLetterDocument.approvalStatus !== 'APPROVED' || !(coverLetterDocument.approvedAt instanceof Date) || !Number.isFinite(coverLetterDocument.approvedAt.getTime()) || coverLetterDocument.approvedBy !== input.userId
          || !coverLetterDocument.encryptionKeyRef?.trim() || coverLetterDocument.scanStatus !== 'CLEAN' || coverLetterDocument.deletedAt || (coverLetterDocument.expiresAt && coverLetterDocument.expiresAt <= new Date())) {
          throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The authorized cover-letter document is unavailable');
        }
        try {
          validateStoredDocumentMetadata(coverLetterDocument, { userId: input.userId, kinds: ['COVER_LETTER'] });
        } catch (error) {
          if (error instanceof DocumentStorageError) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The authorized cover-letter document metadata is invalid');
          throw error;
        }
      }
      const provider = providerFor(authorization.application.job.source);
      const targetUrl = authorization.application.job.applicationUrl;
      const coverLetter = authorization.application.coverLetter?.userId === input.userId ? authorization.application.coverLetter.content : undefined;
      return { provider, targetUrl, allowedHost: providerHost(targetUrl, provider), profile: profileFor(authorization.user.profile), approvedAnswers: approvedAnswersFor(authorization.application.questionsNormalized ?? [], input.userId, coverLetter), coverLetter: coverLetter?.trim() || undefined, document, coverLetterDocument: coverLetterDocument ?? undefined } satisfies PreparedSubmission;
    });

    const file = await this.documentStorage.readAuthorized(input.userId, prepared.document);
    let coverLetterFile: Awaited<ReturnType<DocumentStoragePort['readAuthorized']>> | undefined;
    const started = await this.browserSessions.start({
      userId: input.userId, applicationId: input.applicationId, targetUrl: prepared.targetUrl, allowedHosts: [prepared.allowedHost],
      workerId: input.workerId, correlationId: input.correlationId, idempotencyKey: `submission-browser:${input.authorizationId}`,
      expiresAt: new Date(Date.now() + sessionLifetimeMs),
    } satisfies StartBrowserSessionInput);
    try {
      let confirmation: SubmissionVerificationEvidence | undefined;
      await this.browserSessions.withPage(input.userId, started.session.externalRef, async page => {
        const port = this.ports[prepared.provider](page);
        let uploadedResume = false;
        let uploadedCoverLetter = false;
        let finalFill: Awaited<ReturnType<GreenhouseApplicationAdapter['fillCurrentStep']>> | undefined;
        const seenStepIdentities = new Set<string>();
        for (let step = 0; step < maxSubmissionSteps; step += 1) {
          const fill = prepared.provider === 'LEVER'
            ? await new LeverApplicationAdapter().fillCurrentStep(port as LeverFormPort, prepared.profile, prepared.approvedAnswers, input.userId)
            : await new GreenhouseApplicationAdapter().fillCurrentStep(port as GreenhouseFormPort, prepared.profile, prepared.approvedAnswers, input.userId);
          if (fill.stepIdentity && seenStepIdentities.has(fill.stepIdentity)) {
            throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The provider repeated a form step identity without advancing');
          }
          if (fill.stepIdentity) seenStepIdentities.add(fill.stepIdentity);
          finalFill = fill;
          const verification = (fill.assessments ?? []).find(assessment => assessment.disposition === 'HUMAN_VERIFICATION_REQUIRED');
          if (verification) {
            await this.requestVerification({
              userId: input.userId,
              applicationId: input.applicationId,
              type: verification.verification ?? 'ANTI_BOT',
              prompt: 'Complete the provider verification in the browser session, then re-authorize this submission.',
              context: { provider: prepared.provider, fieldId: verification.fieldId, authorizationId: input.authorizationId },
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              correlationId: input.correlationId,
              idempotencyKey: `submission-human-verification:${input.authorizationId}:${verification.fieldId}`,
            });
            throw new ProviderSubmissionError('HUMAN_VERIFICATION_REQUIRED', 'Provider verification requires human completion before submission can be re-authorized');
          }
          if (fill.validationErrors.length
            || fill.requiredBlockingFieldIds.some(id => {
              const field = fill.fields.find(candidate => candidate.id === id);
              return !this.isResumeField(field) && !this.isCoverLetterField(field)
                && !(this.isCoverLetterTextField(field) && Boolean(prepared.coverLetter));
            })) {
            throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application contains fields that require a human review before submission');
          }
          const fileFields = fill.fields.filter(field => this.isResumeField(field));
          if (fileFields.length > 1 || (fileFields.length === 1 && uploadedResume)) {
            throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application contains an ambiguous or repeated resume upload control');
          }
          // Field ids whose blocker this submission resolved by supplying the exact
          // authorized document; the adapter judged completion before these ran.
          const resolvedFieldIds: string[] = [];
          if (fileFields.length === 1) {
            if (!port.uploadDocument) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The provider does not expose a certified document-upload capability');
            await port.uploadDocument(fileFields[0].id, {
              fileName: file.fileName,
              mimeType: file.mimeType,
              checksumSha256: prepared.document.checksumSha256,
              bytes: file.buffer,
            });
            uploadedResume = true;
            resolvedFieldIds.push(fileFields[0].id);
          }
          const coverLetterFields = fill.fields.filter(field => this.isCoverLetterField(field));
          if (coverLetterFields.length > 1 || (coverLetterFields.length === 1 && uploadedCoverLetter)) {
            throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application contains an ambiguous or repeated cover-letter upload control');
          }
          if (coverLetterFields.length === 1) {
            if (!prepared.coverLetterDocument) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'A cover-letter upload control requires an exact approved cover-letter document');
            if (!coverLetterFile) coverLetterFile = await this.documentStorage.readAuthorized(input.userId, prepared.coverLetterDocument);
            if (!port.uploadDocument) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The provider does not expose a certified document-upload capability');
            await port.uploadDocument(coverLetterFields[0].id, {
              fileName: coverLetterFile.fileName,
              mimeType: coverLetterFile.mimeType,
              checksumSha256: prepared.coverLetterDocument.checksumSha256,
              bytes: coverLetterFile.buffer,
            });
            uploadedCoverLetter = true;
            resolvedFieldIds.push(coverLetterFields[0].id);
          }
          const coverLetterTextFields = fill.fields.filter(field => this.isCoverLetterTextField(field));
          if (coverLetterTextFields.length > 1) {
            throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application contains an ambiguous or repeated cover-letter text control');
          }
          if (coverLetterTextFields.length === 1 && prepared.coverLetter) {
            await port.fill(coverLetterTextFields[0].id, prepared.coverLetter);
            resolvedFieldIds.push(coverLetterTextFields[0].id);
          }
          // Re-evaluate completion now that the authorized documents are attached. Reading
          // the adapter's earlier verdict instead would fail every multi-step provider form
          // whose step carries a required resume upload: the upload succeeds here, and the
          // step would still be reported as unable to advance. Only the blocker this
          // submission actually resolved is removed; everything else still stops the loop.
          const stepResult = await advanceStepIfComplete(port, {
            ...fill,
            requiredBlockingFieldIds: fill.requiredBlockingFieldIds.filter(id => !resolvedFieldIds.includes(id)),
          });
          if (!stepResult.hasNextStep) break;
          if (!stepResult.advanced) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The provider did not safely advance the application step');
          if (step === maxSubmissionSteps - 1) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The application exceeded the safe step limit');
        }
        if (!finalFill || !uploadedResume) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'Exactly one verified resume upload field is required for automatic submission');
        const invalid = await page.locator('form :invalid').count();
        if (invalid !== 0) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'Provider-side validation rejected the prepared application');
        const submit = page.locator('form button[type="submit"]:not([disabled]), form input[type="submit"]:not([disabled])');
        if (await submit.count() !== 1) throw new ProviderSubmissionError('PRECONDITION_FAILED', 'The provider submit control is ambiguous or unavailable');
        await submit.first().click({ timeout: 15_000 });
        attemptedAt = new Date();
        const body = page.locator('body');
        if (typeof body.innerText === 'function') {
          try {
            confirmation = parseProviderConfirmation({
              applicationId: input.applicationId,
              provider: prepared.provider,
              pageText: await body.innerText({ timeout: 5_000 }),
              observedAt: attemptedAt,
            });
          } catch (error) {
            // A provider may not expose a parseable marker. The submission stays
            // UNCONFIRMED and requires independent reconciliation; parser failure
            // must never turn a post-click outcome into a false success.
            if (!(error instanceof SubmissionVerificationError)) confirmation = undefined;
          }
        }
      });
      if (!attemptedAt) throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'Provider submission completed without a durable attempt timestamp');
      return { provider: prepared.provider, attemptedAt, confirmation };
    } catch (error) {
      if (error instanceof ProviderSubmissionError) throw error;
      throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'Provider submission outcome is indeterminate after the authorized attempt');
    } finally {
      await this.browserSessions.close(input.userId, started.session.externalRef, input.correlationId);
    }
  }

  private isResumeField(field: { kind: string; name: string; label: string; accessibleName?: string } | undefined): boolean {
    return field?.kind === 'FILE' && /resume|cv/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`);
  }

  private isCoverLetterField(field: { kind: string; name: string; label: string; accessibleName?: string } | undefined): boolean {
    return field?.kind === 'FILE' && /cover[\s_-]*letter/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`);
  }

  private isCoverLetterTextField(field: { kind: string; name: string; label: string; accessibleName?: string } | undefined): boolean {
    return Boolean(field && (field.kind === 'TEXT' || field.kind === 'TEXTAREA') && /cover[\s_-]*letter/i.test(`${field.name} ${field.label} ${field.accessibleName ?? ''}`));
  }
}
