import { describe, expect, it, vi } from 'vitest';
import type { GreenhouseFormPort, GreenhouseFillResult } from '@jobagent/job-engine';
import { GreenhouseApplicationService, fillApprovedCoverLetterDocument, fillApprovedResumeDocument, fillSupplementaryText } from './greenhouse-application';

const describeDatabase = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL) ? describe : describe.skip;

function formPort(snapshot: Awaited<ReturnType<GreenhouseFormPort['snapshot']>>) {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  } satisfies GreenhouseFormPort;
}

describe('approved cover-letter document transport', () => {
  it('uploads only the exact clean attached artifact and clears its required blocker', async () => {
    const uploadDocument = vi.fn(async () => undefined);
    const validate = vi.fn(async () => []);
    const port = { uploadDocument, validate } as unknown as GreenhouseFormPort;
    const document = {
      id: 'cover-object', userId: 'user-1', kind: 'COVER_LETTER', resumeVersionId: null,
      bucket: 'private', objectKey: 'private/cover_letter/user-1/' + 'd'.repeat(64), versionId: null,
      fileName: 'cover-letter.pdf', mimeType: 'application/pdf', checksumSha256: 'd'.repeat(64),
      byteSize: BigInt(20), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null, approvalStatus: 'APPROVED', approvedAt: new Date('2026-09-14T00:00:00Z'), approvedBy: 'user-1',
    };
    const storage = { readAuthorized: vi.fn(async () => ({ buffer: Buffer.from('%PDF-cover'), fileName: document.fileName, mimeType: 'application/pdf' as const })) };
    const result = {
      step: 1, stepIdentity: 'step-1', hasNextStep: false, fields: [{ id: 'cover', name: 'cover_letter', label: 'Cover Letter', kind: 'FILE', required: true }],
      filledFieldIds: [], requiredBlockingFieldIds: ['cover'], assessments: [], validationErrors: [], advanced: false,
    } as GreenhouseFillResult;

    const updated = await fillApprovedCoverLetterDocument(port, result, document, 'user-1', storage);
    expect(storage.readAuthorized).toHaveBeenCalledWith('user-1', document);
    expect(uploadDocument).toHaveBeenCalledWith('cover', expect.objectContaining({ fileName: 'cover-letter.pdf', checksumSha256: 'd'.repeat(64) }));
    expect(updated.filledFieldIds).toEqual(['cover']);
    expect(updated.requiredBlockingFieldIds).toEqual([]);
  });

  it('fails closed without reading or uploading an unavailable artifact', async () => {
    const port = { uploadDocument: vi.fn(), validate: vi.fn(async () => []) } as unknown as GreenhouseFormPort;
    const storage = { readAuthorized: vi.fn() };
    const result = {
      step: 1, stepIdentity: 'step-1', hasNextStep: false, fields: [{ id: 'cover', name: 'cover_letter', label: 'Cover Letter', kind: 'FILE', required: true }],
      filledFieldIds: [], requiredBlockingFieldIds: ['cover'], assessments: [], validationErrors: [], advanced: false,
    } as GreenhouseFillResult;
    const updated = await fillApprovedCoverLetterDocument(port, result, null, 'user-1', storage);
    expect(storage.readAuthorized).not.toHaveBeenCalled();
    expect(port.uploadDocument).not.toHaveBeenCalled();
    expect(updated.requiredBlockingFieldIds).toEqual(['cover']);
  });
});

describe('approved resume document transport', () => {
  it('fails closed when the exact resume artifact has no owner approval metadata', async () => {
    const uploadDocument = vi.fn(async () => undefined);
    const port = { uploadDocument, validate: vi.fn(async () => []) } as unknown as GreenhouseFormPort;
    const document = {
      id: 'resume-object', userId: 'user-1', kind: 'RESUME_APPROVED', resumeVersionId: 'version-1',
      bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'e'.repeat(64), versionId: null,
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'e'.repeat(64), byteSize: BigInt(20),
      scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
    };
    const storage = { readAuthorized: vi.fn() };
    const result = {
      step: 1, stepIdentity: 'step-1', hasNextStep: false, fields: [{ id: 'resume', name: 'resume', label: 'Resume', kind: 'FILE', required: true }],
      filledFieldIds: [], requiredBlockingFieldIds: ['resume'], assessments: [], validationErrors: [], advanced: false,
    } as GreenhouseFillResult;
    const updated = await fillApprovedResumeDocument(port, result, document, 'version-1', 'user-1', storage);
    expect(storage.readAuthorized).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
    expect(updated.requiredBlockingFieldIds).toEqual(['resume']);
  });

  it('fails closed when multiple resume file controls are present', async () => {
    const uploadDocument = vi.fn(async () => undefined);
    const port = { uploadDocument, validate: vi.fn(async () => []) } as unknown as GreenhouseFormPort;
    const document = {
      id: 'resume-object', userId: 'user-1', kind: 'RESUME_APPROVED', resumeVersionId: 'version-1',
      bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'e'.repeat(64), versionId: null,
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'e'.repeat(64),
      byteSize: BigInt(20), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null, approvalStatus: 'APPROVED', approvedAt: new Date('2026-09-14T00:00:00Z'), approvedBy: 'user-1',
    };
    const storage = { readAuthorized: vi.fn(async () => ({ buffer: Buffer.from('%PDF-resume'), fileName: 'resume.pdf', mimeType: 'application/pdf' as const })) };
    const result = {
      step: 1, stepIdentity: 'step-1', hasNextStep: false, fields: [
        { id: 'resume-a', name: 'resume', label: 'Resume', kind: 'FILE', required: true },
        { id: 'resume-b', name: 'cv', label: 'CV', kind: 'FILE', required: true },
      ], filledFieldIds: [], requiredBlockingFieldIds: [], assessments: [], validationErrors: [], advanced: false,
    } as GreenhouseFillResult;
    const updated = await fillApprovedResumeDocument(port, result, document, 'version-1', 'user-1', storage);
    expect(storage.readAuthorized).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
    expect(updated.requiredBlockingFieldIds).toEqual(['resume-a', 'resume-b']);
  });
});

describe('approved cover-letter text transport', () => {
  it('fails closed when duplicate cover-letter text controls are present', async () => {
    const fill = vi.fn(async () => undefined);
    const result = {
      step: 1, stepIdentity: 'step-1', hasNextStep: false, fields: [
        { id: 'cover-a', name: 'cover_letter', label: 'Cover Letter', kind: 'TEXTAREA', required: true },
        { id: 'cover-b', name: 'cover_letter_alt', label: 'Cover Letter', kind: 'TEXTAREA', required: false },
      ], filledFieldIds: [], requiredBlockingFieldIds: ['cover-a'], assessments: [], validationErrors: [], advanced: false,
    } as GreenhouseFillResult;
    const port = { fill, validate: vi.fn(async () => []) } as unknown as GreenhouseFormPort;
    const updated = await fillSupplementaryText(port, result, 'Approved cover letter');
    expect(fill).not.toHaveBeenCalled();
    expect(updated.requiredBlockingFieldIds).toEqual(['cover-a', 'cover-b']);
  });
});

describeDatabase('GreenhouseApplicationService', () => {
  it('fills a safe validated form without exposing profile values in durable answers', async () => {
    const port = formPort({
      step: 1,
      hasNextStep: false,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });
    const browserSessions = {
      start: vi.fn(async () => ({ session: { externalRef: 'session' }, replayed: false })),
      withPage: vi.fn(async (_userId, _reference, operation) => operation({})),
      close: vi.fn(async () => undefined),
    };
    const service = new GreenhouseApplicationService(
      browserSessions as never,
      () => port as never,
    );

    await expect(service.execute({
      userId: 'user', applicationId: 'application', workerId: 'worker', correlationId: 'correlation', idempotencyKey: 'key',
    })).rejects.toThrow('Application or user profile not found');
    expect(browserSessions.start).not.toHaveBeenCalled();
  });
});
