import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  DocumentStorage,
  DocumentStorageError,
  ClamAvDocumentScanner,
  type DocumentScanner,
  validateDocumentUpload,
  validateStoredDocumentMetadata,
  attachDocumentToApplicationInTransaction,
  approveDocumentMetadataInTransaction,
} from './document-storage';

const cleanScanner: DocumentScanner = { scan: async () => ({ status: 'CLEAN', engine: 'fixture' }) };
const pdf = Buffer.from('%PDF-1.7\nfixture');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe('document storage validation', () => {
  it('rejects credential-bearing S3 endpoints at the storage-client boundary', async () => {
    vi.stubEnv('S3_DOCUMENT_BUCKET', 'private-documents');
    vi.stubEnv('S3_ENDPOINT', 'https://user:password@example.test:9000/storage?token=secret');
    try {
      await expect(new DocumentStorage(cleanScanner).storeArtifact({ userId: 'user-1', kind: 'SCREENSHOT', fileName: 'shot.png', mimeType: 'image/png', buffer: png })).rejects.toThrow('credentials or query data');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['UPPERCASE', 'ab', 'bucket..name', 'bucket-.name', '192.168.1.1'])('rejects an invalid S3 bucket name: %s', async bucket => {
    vi.stubEnv('S3_DOCUMENT_BUCKET', bucket);
    try {
      await expect(new DocumentStorage(cleanScanner).storeArtifact({ userId: 'user-1', kind: 'SCREENSHOT', fileName: 'shot.png', mimeType: 'image/png', buffer: png })).rejects.toThrow('bucket is invalid');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['UPPERCASE', 'ab', 'bucket..name', 'bucket-.name', '192.168.1.1'])('rejects an invalid S3 bucket name: %s', async bucket => {
    vi.stubEnv('S3_DOCUMENT_BUCKET', bucket);
    try {
      await expect(new DocumentStorage(cleanScanner).storeArtifact({ userId: 'user-1', kind: 'SCREENSHOT', fileName: 'shot.png', mimeType: 'image/png', buffer: png })).rejects.toThrow('bucket is invalid');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects an unbounded document-scanner timeout configuration', () => {
    expect(() => new ClamAvDocumentScanner(undefined, 999)).toThrow(DocumentStorageError);
  });

  it('fails closed on invalid scanner input before invoking ClamAV', async () => {
    const scanner = new ClamAvDocumentScanner(undefined);
    await expect(scanner.scan(Buffer.alloc(10 * 1024 * 1024 + 1))).resolves.toEqual({ status: 'ERROR', engine: 'clamav-input' });
  });

  it('accepts matching PDF bytes and produces a stable SHA-256 checksum', () => {
    expect(validateDocumentUpload({ buffer: pdf, fileName: 'resume.pdf', mimeType: 'application/pdf' }))
      .toEqual({ mimeType: 'application/pdf', checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' });
  });

  it.each([
    [png, 'screenshot.png', 'image/png'],
    [jpeg, 'receipt.jpeg', 'image/jpeg'],
  ] as const)('accepts approved image artifacts: %s', (buffer, fileName, mimeType) => {
    expect(validateDocumentUpload({ buffer, fileName, mimeType }).mimeType).toBe(mimeType);
  });

  it('rejects non-private or malformed stored object references', () => {
    expect(() => validateStoredDocumentMetadata({
      bucket: 'private', objectKey: 'public/resume', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).toThrow(DocumentStorageError);
  });

  it('rejects empty bucket metadata even when the object path looks private', () => {
    expect(() => validateStoredDocumentMetadata({
      bucket: '', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf',
      mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).toThrow(DocumentStorageError);
  });

  it('rejects an explicitly missing encryption reference on stored metadata', () => {
    expect(() => validateStoredDocumentMetadata({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf',
      mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: null,
    })).toThrow(DocumentStorageError);
  });

  it('rejects a content-addressed reference whose key digest differs from its checksum', () => {
    expect(() => validateStoredDocumentMetadata({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf',
      mimeType: 'application/pdf', checksumSha256: 'b'.repeat(64), byteSize: BigInt(pdf.length),
    })).toThrow(DocumentStorageError);
  });

  it('rejects metadata whose artifact kind differs from the private object path', () => {
    expect(() => validateStoredDocumentMetadata({
      userId: 'user-1', kind: 'RESUME_SOURCE', bucket: 'private',
      objectKey: 'private/screenshot/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    }, { userId: 'user-1', kinds: ['RESUME_SOURCE'] })).toThrow(DocumentStorageError);
  });

  it('rejects runtime artifact kinds outside the supported document policy', () => {
    expect(() => validateStoredDocumentMetadata({
      userId: 'user-1', kind: 'UNAUTHORIZED' as never, bucket: 'private', objectKey: 'private/unauthorized/user-1/' + 'a'.repeat(64),
      fileName: 'evidence.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED',
    }, { userId: 'user-1' })).toThrow('unsupported');
  });

  it('rejects embedded owner metadata that does not match its private object path', () => {
    expect(() => validateStoredDocumentMetadata({
      userId: 'user-2', kind: 'RESUME_SOURCE', bucket: 'private',
      objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).toThrow('owner does not match');
  });

  it('rejects malformed upload metadata before inspecting file contents', () => {
    expect(() => validateDocumentUpload(undefined as never)).toThrow('upload metadata is invalid');
    expect(() => validateDocumentUpload({ buffer: 'not-bytes', fileName: 'resume.pdf', mimeType: 'application/pdf' } as never)).toThrow('upload metadata is invalid');
  });

  it('rejects malformed application attachment identities before tenant queries', async () => {
    const findFirst = vi.fn();
    const tx = { application: { findFirst }, objectMetadata: { findFirst } };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application\n1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toThrow('Application identity');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [{ buffer: Buffer.from('not a PDF'), fileName: 'resume.pdf', mimeType: 'application/pdf' }],
    [{ buffer: pdf, fileName: 'resume.pdf', mimeType: 'text/plain' }],
    [{ buffer: Buffer.from('safe\0text'), fileName: 'resume.txt', mimeType: 'text/plain' }],
  ])('rejects forged type evidence', input => {
    expect(() => validateDocumentUpload(input)).toThrow(DocumentStorageError);
  });

  it.each(['', 'resume\n.pdf', 'resume\r.pdf', `${'a'.repeat(201)}.pdf`])('rejects unsafe upload filenames: %j', fileName => {
    expect(() => validateDocumentUpload({ buffer: pdf, fileName, mimeType: 'application/pdf' })).toThrow(DocumentStorageError);
  });

  it('fails closed when malware scanning is unavailable', async () => {
    const scanner: DocumentScanner = { scan: async () => ({ status: 'ERROR', engine: 'fixture' }) };
    const storage = new DocumentStorage(scanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' } satisfies Partial<DocumentStorageError>);
  });

  it('fails closed when malware is detected', async () => {
    const scanner: DocumentScanner = { scan: async () => ({ status: 'INFECTED', engine: 'fixture' }) };
    const storage = new DocumentStorage(scanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'MALWARE_DETECTED' } satisfies Partial<DocumentStorageError>);
  });

  it('does not need storage configuration until an upload passes scanning', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage is not configured'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' } satisfies Partial<DocumentStorageError>);
  });

  it('rejects an unsafe owner before scanning or touching object storage', async () => {
    const scanner = { scan: vi.fn(async () => ({ status: 'CLEAN' as const, engine: 'fixture' })) };
    const storage = new DocumentStorage(scanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.storeResume({ userId: 'user-1/other', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('uses S3-managed AES256 encryption unless a customer KMS key is configured', async () => {
    let command: { input?: { ChecksumSHA256?: string; ServerSideEncryption?: string; SSEKMSKeyId?: string } } | undefined;
    const client = { send: async (request: { input?: { ChecksumSHA256?: string; ServerSideEncryption?: string; SSEKMSKeyId?: string } }) => {
      command = request;
      return { VersionId: 'v1' };
    } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .resolves.toMatchObject({ versionId: 'v1', encryptionKeyRef: 'S3_MANAGED' });
    expect(command?.input).toMatchObject({ ServerSideEncryption: 'AES256' });
    expect(command?.input?.ChecksumSHA256).toBe(Buffer.from('f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', 'hex').toString('base64'));
    expect(command?.input?.SSEKMSKeyId).toBeUndefined();
  });

  it('stores each supported artifact kind under a tenant-scoped private prefix', async () => {
    const keys: string[] = [];
    const client = { send: async (request: { input?: { Key?: string } }) => { keys.push(request.input?.Key ?? ''); return {}; } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await storage.storeArtifact({ userId: 'user-1', kind: 'APPLICATION_EVIDENCE', fileName: 'evidence.pdf', mimeType: 'application/pdf', buffer: pdf });
    expect(keys[0]).toMatch(/^private\/application_evidence\/user-1\/[a-f0-9]{64}$/);
  });

  it('reconciles a conditional-put race only with the exact existing object', async () => {
    let calls = 0;
    const client = { send: async (request: { input?: { Metadata?: Record<string, string> } }) => {
      calls += 1;
      if (calls === 1) throw new Error('precondition failed');
      expect(request.input?.Metadata).toBeUndefined();
      return { ContentLength: pdf.length, ContentType: 'application/pdf', Metadata: { sha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' }, ServerSideEncryption: 'AES256', VersionId: 'existing-version' };
    } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .resolves.toMatchObject({ versionId: 'existing-version', checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' });
  });

  it('does not reconcile an identically hashed object with the wrong encryption mode', async () => {
    let calls = 0;
    const client = { send: async (request: { input?: { Metadata?: Record<string, string> } }) => {
      calls += 1;
      if (calls === 1) throw new Error('precondition failed');
      expect(request.input?.Metadata).toBeUndefined();
      return { ContentLength: pdf.length, ContentType: 'application/pdf', Metadata: { sha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' }, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'different-key' };
    } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('does not resurrect a deleted immutable document identity', async () => {
    const tx = {
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'old-object', userId: 'user-1', kind: 'RESUME_SOURCE', deletedAt: new Date() })) },
    };
    await expect((await import('./document-storage')).persistDocumentMetadataInTransaction(tx as never, {
      userId: 'user-1',
      stored: { kind: 'RESUME_SOURCE', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: pdf.length, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not replay an immutable identity across encryption configurations', async () => {
    const objectKey = 'private/resume_source/user-1/' + 'a'.repeat(64);
    const tx = {
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'existing-object', userId: 'user-1', kind: 'RESUME_SOURCE', bucket: 'private', objectKey, versionId: null, fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', deletedAt: null })) },
    };
    await expect((await import('./document-storage')).persistDocumentMetadataInTransaction(tx as never, {
      userId: 'user-1', stored: { kind: 'RESUME_SOURCE', bucket: 'private', objectKey, fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: pdf.length, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'kms/other-key', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not replay identical bytes across different resume-version bindings', async () => {
    const objectKey = 'private/cover_letter/user-1/' + 'a'.repeat(64);
    const tx = {
      resumeVersion: { findFirst: vi.fn(async () => ({ id: 'version-2' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'existing-object', userId: 'user-1', kind: 'COVER_LETTER', resumeVersionId: 'version-1', bucket: 'private', objectKey, versionId: null, fileName: 'cover.txt', mimeType: 'text/plain', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', deletedAt: null })) },
    };
    await expect((await import('./document-storage')).persistDocumentMetadataInTransaction(tx as never, {
      userId: 'user-1', resumeVersionId: 'version-2', stored: { kind: 'COVER_LETTER', bucket: 'private', objectKey, fileName: 'cover.txt', mimeType: 'text/plain', byteSize: 42, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects metadata that pairs a resume with a version owned by another resume', async () => {
    const tx = {
      resumeVersion: { findFirst: vi.fn(async () => ({ id: 'version-2', resumeId: 'resume-2' })) },
      resume: { findFirst: vi.fn(async () => ({ id: 'resume-1' })) },
      objectMetadata: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect((await import('./document-storage')).persistDocumentMetadataInTransaction(tx as never, {
      userId: 'user-1', resumeId: 'resume-1', resumeVersionId: 'version-2',
      stored: { kind: 'RESUME_APPROVED', bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: pdf.length, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    expect(tx.objectMetadata.create).not.toHaveBeenCalled();
  });

  it('rejects metadata persistence when encryption provenance is missing', async () => {
    const tx = {
      objectMetadata: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect((await import('./document-storage')).persistDocumentMetadataInTransaction(tx as never, {
      userId: 'user-1',
      stored: { kind: 'RESUME_SOURCE', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: pdf.length, checksumSha256: 'a'.repeat(64), encryptionKeyRef: undefined as never, scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } },
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    expect(tx.objectMetadata.findFirst).not.toHaveBeenCalled();
    expect(tx.objectMetadata.create).not.toHaveBeenCalled();
  });

  it('records explicit owner approval with an audit event', async () => {
    const object = {
      id: 'object-approval', userId: 'user-1', kind: 'RESUME_APPROVED', bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'a'.repeat(64),
      versionId: null, fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(pdf.length), checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED',
      scanStatus: 'CLEAN', deletedAt: null, expiresAt: null, approvalStatus: 'UNAPPROVED', approvedAt: null, approvedBy: null,
    };
    const tx = {
      objectMetadata: { findFirst: vi.fn(async () => object), update: vi.fn(async () => ({ ...object, approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'user-1' })) },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    await expect(approveDocumentMetadataInTransaction(tx as never, 'user-1', object.id)).resolves.toMatchObject({ approvalStatus: 'APPROVED', approvedBy: 'user-1' });
    expect(tx.objectMetadata.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approvalStatus: 'APPROVED', approvedBy: 'user-1' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'DOCUMENT_APPROVED' }) }));
  });

  it('attaches only the exact clean document version and replays the same reference', async () => {
    const document = { id: 'application-document-1', applicationId: 'application-1', objectMetadataId: 'object-1', type: 'resume', fileName: 'resume.pdf', filePath: 'private/resume_tailored/user-1/' + 'a'.repeat(64), mimeType: 'application/pdf', uploadedAt: new Date() };
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'RESUME_TAILORED', bucket: 'private', objectKey: document.filePath, versionId: null, scanStatus: 'CLEAN', deletedAt: null, fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'user-1' })) },
      applicationDocument: { findFirst: vi.fn<() => Promise<typeof document | null>>(async () => null), create: vi.fn(async () => document) },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).resolves.toMatchObject({ replayed: false, document: { objectMetadataId: 'object-1' } });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    tx.applicationDocument.findFirst.mockResolvedValueOnce(document);
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).resolves.toMatchObject({ replayed: true });
    expect(tx.applicationDocument.create).toHaveBeenCalledOnce();
  });

  it('does not attach a clean but unapproved document to an application', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'RESUME_TAILORED', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64), versionId: null, scanStatus: 'CLEAN', deletedAt: null, expiresAt: null, approvalStatus: 'UNAPPROVED', approvedAt: null, approvedBy: null, fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' })) },
      applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(tx.applicationDocument.create).not.toHaveBeenCalled();
  });

  it('does not attach a document with an invalid approval timestamp', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'RESUME_TAILORED', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64), versionId: null, scanStatus: 'CLEAN', deletedAt: null, expiresAt: null, approvalStatus: 'APPROVED', approvedAt: new Date(Number.NaN), approvedBy: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' })) },
      applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(tx.applicationDocument.create).not.toHaveBeenCalled();
  });

  it('replays an application binding when a concurrent unique insert wins the race', async () => {
    const document = { id: 'application-document-1', applicationId: 'application-1', objectMetadataId: 'object-1', type: 'other', fileName: 'evidence.png', filePath: 'private/screenshot/user-1/' + 'a'.repeat(64), mimeType: 'image/png', uploadedAt: new Date() };
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'SCREENSHOT', bucket: 'private', objectKey: document.filePath, versionId: null, scanStatus: 'CLEAN', deletedAt: null, fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'user-1' })) },
      applicationDocument: { findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(document), create: vi.fn().mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' })) },
      auditLog: { create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'other',
    })).resolves.toMatchObject({ replayed: true, document: { id: 'application-document-1' } });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an object owned by another resume version', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-2', scanStatus: 'CLEAN', deletedAt: null })) },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it('rejects an artifact kind that does not match the requested application document type', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'SCREENSHOT', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'a'.repeat(64), versionId: null, scanStatus: 'CLEAN', deletedAt: null, fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42) })) },
      applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    expect(tx.applicationDocument.create).not.toHaveBeenCalled();
  });

  it('rejects an expired exact document before creating an application binding', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'RESUME_TAILORED', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64), versionId: null, scanStatus: 'CLEAN', deletedAt: null, expiresAt: new Date(Date.now() - 1000), fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42) })) },
      applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    expect(tx.applicationDocument.create).not.toHaveBeenCalled();
  });

  it('rejects an exact document with malformed expiry metadata', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', resumeVersionId: 'version-1' })) },
      objectMetadata: { findFirst: vi.fn(async () => ({ id: 'object-1', userId: 'user-1', resumeVersionId: 'version-1', kind: 'RESUME_TAILORED', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64), versionId: null, scanStatus: 'CLEAN', deletedAt: null, expiresAt: new Date(Number.NaN), approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' })) },
      applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(attachDocumentToApplicationInTransaction(tx as never, {
      userId: 'user-1', applicationId: 'application-1', resumeVersionId: 'version-1', objectMetadataId: 'object-1', type: 'resume',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(tx.applicationDocument.create).not.toHaveBeenCalled();
  });

  it('returns only a stored document whose metadata, content, and checksum agree', async () => {
    let calls = 0;
    const client = { send: async () => ++calls === 1
      ? { ContentLength: pdf.length, ContentType: 'application/pdf', Metadata: { sha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' }, ServerSideEncryption: 'AES256' }
      : { ServerSideEncryption: 'AES256', Body: { transformToByteArray: async () => pdf } } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));

    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).resolves.toEqual({ buffer: pdf, fileName: 'resume.pdf', mimeType: 'application/pdf' });
  });

  it('treats hexadecimal checksum casing consistently at the verified-read boundary', async () => {
    const checksum = 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224';
    let calls = 0;
    const client = { send: async () => ++calls === 1
      ? { ContentLength: pdf.length, ContentType: 'application/pdf', Metadata: { sha256: checksum }, ServerSideEncryption: 'AES256' }
      : { ServerSideEncryption: 'AES256', Body: { transformToByteArray: async () => pdf } } };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.readVerified({
      bucket: 'private', objectKey: `private/resume_source/user-1/${checksum.toUpperCase()}`, fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: checksum.toUpperCase(), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).resolves.toEqual({ buffer: pdf, fileName: 'resume.pdf', mimeType: 'application/pdf' });
  });

  it('rejects an object whose integrity metadata is incomplete', async () => {
    const storage = new DocumentStorage(cleanScanner, () => ({
      bucket: 'private', client: { send: vi.fn(async () => ({ ServerSideEncryption: 'AES256' })) } as never, encryptionKeyRef: 'S3_MANAGED',
    }));
    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('refuses to read an object whose server-side encryption changed', async () => {
    const send = vi.fn(async () => ({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'unexpected-key' }));
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: { send } as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { ContentLength: pdf.length + 1 },
    { ContentType: 'text/plain' },
    { Metadata: { sha256: 'b'.repeat(64) } },
  ])('rejects conflicting object-store integrity metadata: %j', async head => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ServerSideEncryption: 'AES256', ...head })
      .mockResolvedValueOnce({ ServerSideEncryption: 'AES256', Body: { transformToByteArray: async () => pdf } });
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: { send } as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects stored document metadata or bytes that fail integrity checks', async () => {
    const client = { send: async () => ({ ServerSideEncryption: 'AES256', Body: { transformToByteArray: async () => Buffer.from('%PDF-1.7\\ncorrupted') } }) };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));

    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    await expect(storage.readVerified({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', fileName: 'resume.pdf', mimeType: 'text/plain',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
    await expect(storage.readVerified({
      bucket: 'other-private-bucket', objectKey: 'resume/1', fileName: 'resume.pdf', mimeType: 'application/pdf',
      checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it.each(['resume\n.pdf', 'resume\r.pdf', ''])('rejects stored filenames with unsafe control characters: %j', fileName => {
    expect(() => validateStoredDocumentMetadata({
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), fileName,
      mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).toThrow(DocumentStorageError);
  });

  it('never deletes or signs a non-private object reference', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('storage must not be used'); });
    const publicReference = { userId: 'user-1', bucket: 'private', objectKey: 'public/resume', fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', deletedAt: null, expiresAt: null };
    await expect(storage.delete(publicReference)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    await expect(storage.signedDownloadUrl('user-1', publicReference)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it.each(['.', '..', 'owner/other', 'owner\\other', 'owner\nother'])('rejects ambiguous or unsafe owner path segments: %j', userId => {
    expect(() => validateStoredDocumentMetadata({
      userId, bucket: 'private', objectKey: `private/resume_source/${userId}/${'a'.repeat(64)}`,
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).toThrow(DocumentStorageError);
  });

  it('treats an already-absent object as a successful idempotent deletion', async () => {
    const storage = new DocumentStorage(cleanScanner, () => ({
      bucket: 'private',
      client: { send: vi.fn(async () => { throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); }) } as never,
      encryptionKeyRef: 'S3_MANAGED',
    }));
    await expect(storage.deleteAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).resolves.toBeUndefined();
  });

  it('binds worker reads to the authenticated document owner before storage access', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-2', bucket: 'private', objectKey: 'private/resume_source/user-2/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it('rejects owner-bound reads when the reference omits its metadata owner', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.readAuthorized('user-1', {
      bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('rejects an unapproved worker document reference before object access', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('object access must not be reached'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42),
      encryptionKeyRef: 'S3_MANAGED', approvalStatus: 'UNAPPROVED', approvedAt: null, approvedBy: null,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it('rejects an approved worker reference that omits its artifact type', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('object access must not be reached'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42),
      encryptionKeyRef: 'S3_MANAGED', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: 'user-1', scanStatus: 'CLEAN',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('rejects an approved worker reference with an invalid approval timestamp', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('object access must not be reached'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-1', kind: 'RESUME_SOURCE', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42),
      encryptionKeyRef: 'S3_MANAGED', approvalStatus: 'APPROVED', approvedAt: new Date(Number.NaN), approvedBy: 'user-1', scanStatus: 'CLEAN',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('rejects authorized access when encryption metadata is absent', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it.each([
    { scanStatus: 'INFECTED' },
    { deletedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1_000) },
  ])('refuses worker reads for unavailable document metadata', async metadata => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.readAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), ...metadata,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('binds signed downloads to the authenticated document owner before presigning', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('presigning must not be reached'); });
    await expect(storage.signedDownloadUrlAuthorized('user-1', {
      userId: 'user-2', bucket: 'private', objectKey: 'private/resume_source/user-2/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });

  it('refuses to presign a clean reference whose object bytes were tampered with', async () => {
    const client = { send: async () => ({ ServerSideEncryption: 'AES256', Body: { transformToByteArray: async () => Buffer.from('%PDF-1.7\\ncorrupted') } }) };
    const storage = new DocumentStorage(cleanScanner, () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }));
    await expect(storage.signedDownloadUrlAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224',
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224', byteSize: BigInt(pdf.length), encryptionKeyRef: 'S3_MANAGED',
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('applies integrity verification to the legacy signing entry point too', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('presigning must not be reached'); });
    await expect(storage.signedDownloadUrl('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_tailored/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42),
      encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
    })).rejects.toThrow('Private document storage could not read the verified upload');
  });

  it.each([
    { scanStatus: 'INFECTED' },
    { deletedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1_000) },
  ])('refuses to sign a document that is not currently downloadable', async metadata => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('presigning must not be reached'); });
    await expect(storage.signedDownloadUrlAuthorized('user-1', {
      userId: 'user-1', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length), ...metadata,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' } satisfies Partial<DocumentStorageError>);
  });

  it('binds deletion to the authenticated document owner before touching storage', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new Error('deletion must not be reached'); });
    await expect(storage.deleteAuthorized('user-1', {
      userId: 'user-2', bucket: 'private', objectKey: 'private/resume_source/user-2/' + 'a'.repeat(64),
      fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), byteSize: BigInt(pdf.length),
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });
});
