import { describe, expect, it, vi } from 'vitest';
import { fillApprovedCoverLetterDocument, fillApprovedResumeDocument } from './greenhouse-application';
import type { ApplicationFormFillResult, GreenhouseFormPort } from '@jobagent/job-engine';
import type { SupportedDocumentMimeType } from './document-storage';

const document = {
  id: 'object-1',
  userId: 'user-1',
  kind: 'RESUME_APPROVED',
  resumeVersionId: 'version-1',
  bucket: 'private-documents',
  objectKey: 'private/resume_approved/user-1/checksum',
  versionId: null,
  fileName: 'approved-resume.pdf',
  mimeType: 'application/pdf' as SupportedDocumentMimeType,
  checksumSha256: 'a'.repeat(64),
  byteSize: BigInt(4),
  scanStatus: 'CLEAN',
  deletedAt: null,
  expiresAt: null,
};

function result(): ApplicationFormFillResult {
  return {
    step: 1, stepIdentity: 'greenhouse-step-1',
    fields: [
      { id: 'resume', name: 'resume', label: 'Resume', kind: 'FILE', required: true, enabled: true },
      { id: 'other', name: 'name', label: 'Name', kind: 'TEXT', required: true, enabled: true },
    ],
    filledFieldIds: [], requiredBlockingFieldIds: ['resume', 'other'], assessments: [], validationErrors: [],
    hasNextStep: false, advanced: false,
  };
}

function port(uploadDocument?: GreenhouseFormPort['uploadDocument']): GreenhouseFormPort {
  return {
    snapshot: vi.fn(), fill: vi.fn(), select: vi.fn(), setChecked: vi.fn(), validate: vi.fn(async () => []),
    advance: vi.fn(), uploadDocument,
  } as unknown as GreenhouseFormPort;
}

describe('exact approved resume document upload', () => {
  it('uploads only the clean document linked to the selected resume version', async () => {
    const upload = vi.fn(async () => undefined);
    const storage = { readAuthorized: vi.fn(async () => ({
      buffer: Buffer.from('%PDF'), fileName: document.fileName, mimeType: document.mimeType,
    })) } as Pick<import('./document-storage').DocumentStorage, 'readAuthorized'>;
    const output = await fillApprovedResumeDocument(port(upload), result(), { ...document, userId: 'authenticated-owner', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'authenticated-owner' }, 'version-1', 'authenticated-owner', storage);

    expect(storage.readAuthorized).toHaveBeenCalledWith('authenticated-owner', expect.objectContaining({ userId: 'authenticated-owner' }));
    expect(upload).toHaveBeenCalledWith('resume', expect.objectContaining({ checksumSha256: document.checksumSha256 }));
    expect(output.requiredBlockingFieldIds).toEqual(['other']);
  });

  it.each([
    ['wrong owner', { userId: 'other-user' }],
    ['wrong version', { resumeVersionId: 'version-2' }],
    ['unclean scan', { scanStatus: 'PENDING' }],
    ['deleted object', { deletedAt: new Date() }],
    ['unsupported artifact kind', { kind: 'SCREENSHOT' }],
  ])('fails closed for %s', async (_reason, override) => {
    const upload = vi.fn(async () => undefined);
    const storage = { readAuthorized: vi.fn() } as Pick<import('./document-storage').DocumentStorage, 'readAuthorized'>;
    const output = await fillApprovedResumeDocument(port(upload), result(), { ...document, ...override }, 'version-1', 'user-1', storage);

    expect(upload).not.toHaveBeenCalled();
    expect(storage.readAuthorized).not.toHaveBeenCalled();
    expect(output.requiredBlockingFieldIds).toEqual(['resume', 'other']);
  });

  it('does not treat a file control with no exact storage reference as complete', async () => {
    const upload = vi.fn(async () => undefined);
    const output = await fillApprovedResumeDocument(port(upload), result(), null, 'version-1', 'user-1', { readAuthorized: vi.fn() } as Pick<import('./document-storage').DocumentStorage, 'readAuthorized'>);
    expect(upload).not.toHaveBeenCalled();
    expect(output.requiredBlockingFieldIds).toContain('resume');
  });

  it('fails closed when a cover-letter artifact is owned by another user or resume version', async () => {
    const upload = vi.fn(async () => undefined);
    const coverLetter = { ...document, kind: 'COVER_LETTER', resumeVersionId: 'version-2' };
    const storage = { readAuthorized: vi.fn() } as Pick<import('./document-storage').DocumentStorage, 'readAuthorized'>;
    const output = await fillApprovedCoverLetterDocument(
      port(upload),
      { ...result(), fields: [{ id: 'cover', name: 'cover_letter', label: 'Cover Letter', kind: 'FILE', required: true }], requiredBlockingFieldIds: ['cover'] },
      { ...coverLetter, userId: 'other-user' }, 'user-1', storage, 'version-1',
    );
    expect(upload).not.toHaveBeenCalled();
    expect(storage.readAuthorized).not.toHaveBeenCalled();
    expect(output.requiredBlockingFieldIds).toEqual(['cover']);
  });
});
