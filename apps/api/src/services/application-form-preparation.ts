import { Prisma } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@jobagent/database';
import { createAutomationJobInTransaction } from './automation-jobs';
import { transitionApplicationInTenant } from './application-state-machine';
import { DocumentStorageError, validateStoredDocumentMetadata } from './document-storage';

export class ApplicationFormPreparationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'PRECONDITION' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'ApplicationFormPreparationError';
  }
}

export interface PrepareApplicationFormInput {
  userId: string;
  applicationId: string;
  idempotencyKey: string;
  correlationId: string;
}

const path = ['RESUME_GENERATED', 'RESUME_VALIDATED', 'ATS_VALIDATED', 'QUEUED', 'APPLICATION_STARTED'] as const;

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ApplicationFormPreparationError('INVALID', `${name} is required`);
  }
}

function hasVerifiedProvenance(value: Prisma.JsonValue): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object'
    && !Array.isArray(item) && typeof (item as Record<string, unknown>).sourceFactId === 'string'
    && typeof (item as Record<string, unknown>).sourceChecksum === 'string');
}

function providerJobType(source: string): 'COMPLETE_GREENHOUSE_APPLICATION' | 'COMPLETE_LEVER_APPLICATION' {
  const normalized = source.trim().toUpperCase();
  if (normalized === 'GREENHOUSE') return 'COMPLETE_GREENHOUSE_APPLICATION';
  if (normalized === 'LEVER') return 'COMPLETE_LEVER_APPLICATION';
  throw new ApplicationFormPreparationError('PRECONDITION', 'Application provider does not support form automation');
}

async function prepareInTransaction(tx: TenantTransaction, input: PrepareApplicationFormInput) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:prepare-form:${input.applicationId}`}, 0))`;
  let application = await tx.application.findFirst({
    where: { id: input.applicationId, userId: input.userId },
    include: {
      job: { select: { id: true, source: true } },
      resumeVersion: { select: {
        id: true, jobId: true, content: true, atsScoreData: true, sourceFacts: true,
        objectMetadata: { select: {
          id: true, userId: true, resumeVersionId: true, kind: true, bucket: true, objectKey: true,
          fileName: true, mimeType: true, byteSize: true, checksumSha256: true, encryptionKeyRef: true,
          scanStatus: true, approvalStatus: true, approvedAt: true, approvedBy: true, deletedAt: true, expiresAt: true,
        } },
      } },
      qualityDecisions: { where: { decision: 'PASS' }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
    },
  });
  if (!application) throw new ApplicationFormPreparationError('NOT_FOUND', 'Application not found');
  const type = providerJobType(application.job.source);
  const document = application.resumeVersion?.objectMetadata;
  if (!application.resumeVersion || application.resumeVersion.jobId !== application.job.id
    || !application.resumeVersion.content.trim() || application.resumeVersion.atsScoreData === null
    || !hasVerifiedProvenance(application.resumeVersion.sourceFacts) || application.qualityDecisions.length !== 1
    || !document || document.resumeVersionId !== application.resumeVersion.id || document.userId !== input.userId
    || document.approvalStatus !== 'APPROVED' || !(document.approvedAt instanceof Date) || !Number.isFinite(document.approvedAt.getTime()) || document.approvedBy !== input.userId
    || document.scanStatus !== 'CLEAN' || Boolean(document.deletedAt) || Boolean(document.expiresAt && document.expiresAt <= new Date())
    || !document.encryptionKeyRef?.trim()) {
    throw new ApplicationFormPreparationError('PRECONDITION', 'A passing quality decision, fact-verified ATS resume, and approved clean document are required');
  }
  try {
    validateStoredDocumentMetadata(document, { userId: input.userId, kinds: ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'] });
  } catch (error) {
    if (error instanceof DocumentStorageError) {
      throw new ApplicationFormPreparationError('PRECONDITION', 'The approved resume document metadata is invalid');
    }
    throw error;
  }
  const currentIndex = application.status === 'QUALIFIED' ? -1 : path.indexOf(application.status as typeof path[number]);
  if (currentIndex < 0 && application.status !== 'QUALIFIED') {
    throw new ApplicationFormPreparationError('CONFLICT', `Application cannot enter form preparation from ${application.status}`);
  }
  for (let index = currentIndex + 1; index < path.length; index += 1) {
    const target = path[index];
    const transitioned = await transitionApplicationInTenant(tx, {
      applicationId: application.id, userId: input.userId, toStatus: target, expectedVersion: application.version,
      actorType: 'USER', actorId: input.userId, reason: `User requested provider form preparation: ${target}`,
      idempotencyKey: `${input.idempotencyKey}:state:${target}`, correlationId: input.correlationId,
      metadata: { preparation: true, provider: application.job.source },
    });
    application = { ...application, ...transitioned.application };
  }
  const automationJob = await createAutomationJobInTransaction(tx, {
    userId: input.userId, applicationId: application.id, type,
    payload: { applicationId: application.id }, payloadVersion: 1, maxAttempts: 3,
    correlationId: input.correlationId, idempotencyKey: `${input.idempotencyKey}:provider`,
  });
  if (!automationJob.replayed) {
    await tx.auditLog.create({ data: {
      userId: input.userId, action: 'APPLICATION_FORM_PREPARATION_QUEUED', resource: 'Application', resourceId: application.id,
      details: {
        automationJobId: automationJob.id, provider: application.job.source, idempotencyKey: input.idempotencyKey,
        resumeDocument: {
          id: document.id, kind: document.kind, resumeVersionId: document.resumeVersionId,
          bucket: document.bucket, objectKey: document.objectKey, fileName: document.fileName,
          mimeType: document.mimeType, byteSize: document.byteSize.toString(), checksumSha256: document.checksumSha256,
          encryptionKeyRef: document.encryptionKeyRef, approvalStatus: document.approvalStatus,
          approvedAt: document.approvedAt.toISOString(), approvedBy: document.approvedBy, scanStatus: document.scanStatus,
        },
      },
    } });
  }
  return { application, automationJob };
}

export function prepareApplicationForForm(input: PrepareApplicationFormInput) {
  requireText(input.userId, 'userId');
  requireText(input.applicationId, 'applicationId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  requireText(input.correlationId, 'correlationId');
  return withTenant(input.userId, tx => prepareInTransaction(tx, input));
}
