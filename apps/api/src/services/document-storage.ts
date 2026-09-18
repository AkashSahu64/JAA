import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Prisma, type ObjectMetadata } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export type SupportedDocumentMimeType = 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain'
  | 'image/png'
  | 'image/jpeg';
export type DocumentArtifactKind = 'RESUME_SOURCE' | 'RESUME_APPROVED' | 'RESUME_TAILORED' | 'COVER_LETTER' | 'APPLICATION_EVIDENCE' | 'SCREENSHOT' | 'RECEIPT';
export type DocumentScanStatus = 'CLEAN' | 'INFECTED' | 'ERROR';
const DOCUMENT_ARTIFACT_KINDS: readonly DocumentArtifactKind[] = ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED', 'COVER_LETTER', 'APPLICATION_EVIDENCE', 'SCREENSHOT', 'RECEIPT'];

export interface StoredDocument {
  kind: DocumentArtifactKind;
  bucket: string;
  objectKey: string;
  versionId?: string;
  fileName: string;
  mimeType: SupportedDocumentMimeType;
  byteSize: number;
  checksumSha256: string;
  encryptionKeyRef: string;
  scanStatus: 'CLEAN';
  scanDetails: { engine: string; scannedAt: string };
}

export class DocumentStorageError extends Error {
  constructor(public readonly code: 'INVALID_DOCUMENT' | 'SCAN_UNAVAILABLE' | 'MALWARE_DETECTED' | 'STORAGE_UNAVAILABLE' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'DocumentStorageError';
  }
}

export interface PersistDocumentMetadataInput {
  userId: string;
  stored: StoredDocument;
  resumeId?: string;
  resumeVersionId?: string;
  provenance?: Record<string, unknown>;
}

function sameStoredObject(left: Pick<ObjectMetadata, 'bucket' | 'objectKey' | 'versionId' | 'byteSize' | 'mimeType' | 'checksumSha256' | 'encryptionKeyRef' | 'scanStatus'>, right: StoredDocument): boolean {
  return left.bucket === right.bucket
    && left.objectKey === right.objectKey
    && (left.versionId ?? null) === (right.versionId ?? null)
    && left.byteSize === BigInt(right.byteSize)
    && left.mimeType === right.mimeType
    && left.checksumSha256.toLowerCase() === right.checksumSha256.toLowerCase()
    && left.encryptionKeyRef === right.encryptionKeyRef
    && left.scanStatus === 'CLEAN';
}

export async function persistDocumentMetadataInTransaction(
  tx: Prisma.TransactionClient,
  input: PersistDocumentMetadataInput,
): Promise<{ metadata: ObjectMetadata; replayed: boolean }> {
  validateDocumentOwner(input.userId);
  if (input.resumeVersionId) {
    const version = await tx.resumeVersion.findFirst({
      where: { id: input.resumeVersionId, resume: { userId: input.userId } },
      select: { id: true, resumeId: true },
    });
    if (!version) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document resume version does not belong to the authenticated owner');
    if (input.resumeId && version.resumeId !== input.resumeId) {
      throw new DocumentStorageError('INVALID_DOCUMENT', 'Document resume and resume version do not match');
    }
  }
  if (input.resumeId) {
    const resume = await tx.resume.findFirst({ where: { id: input.resumeId, userId: input.userId }, select: { id: true } });
    if (!resume) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document resume does not belong to the authenticated owner');
  }
  validateStoredDocumentMetadata({
    userId: input.userId,
    kind: input.stored.kind,
    bucket: input.stored.bucket,
    objectKey: input.stored.objectKey,
    fileName: input.stored.fileName,
    mimeType: input.stored.mimeType,
    checksumSha256: input.stored.checksumSha256,
    byteSize: BigInt(input.stored.byteSize),
    encryptionKeyRef: input.stored.encryptionKeyRef,
  }, { userId: input.userId, kinds: [input.stored.kind] });
  // Metadata persistence is a security boundary too: do not allow callers
  // that bypass the upload path to create an object reference without proof
  // of the configured encryption mode.
  requireStoredEncryptionReference(input.stored);
  const existing = await tx.objectMetadata.findFirst({
    where: { userId: input.userId, kind: input.stored.kind, checksumSha256: input.stored.checksumSha256 },
  });
  if (existing) {
    if (existing.deletedAt) throw new DocumentStorageError('CONFLICT', 'This immutable document identity has already been deleted');
    if (!sameStoredObject(existing, input.stored) || existing.resumeId !== (input.resumeId ?? null) || existing.resumeVersionId !== (input.resumeVersionId ?? null)) throw new DocumentStorageError('CONFLICT', 'A different object already owns this document identity');
    return { metadata: existing, replayed: true };
  }
  const metadata = await tx.objectMetadata.create({
    data: {
      userId: input.userId,
      bucket: input.stored.bucket,
      objectKey: input.stored.objectKey,
      versionId: input.stored.versionId,
      kind: input.stored.kind,
      fileName: input.stored.fileName,
      mimeType: input.stored.mimeType,
      byteSize: BigInt(input.stored.byteSize),
      checksumSha256: input.stored.checksumSha256,
      encryptionKeyRef: input.stored.encryptionKeyRef,
      scanStatus: input.stored.scanStatus,
      scanDetails: input.stored.scanDetails as Prisma.InputJsonValue,
      provenance: input.provenance as Prisma.InputJsonValue | undefined,
      resumeId: input.resumeId,
      resumeVersionId: input.resumeVersionId,
    },
  });
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: 'DOCUMENT_METADATA_PERSISTED',
      resource: 'ObjectMetadata',
      resourceId: metadata.id,
      details: { kind: metadata.kind, checksumSha256: metadata.checksumSha256, byteSize: metadata.byteSize.toString() },
    },
  });
  return { metadata, replayed: false };
}

export async function persistDocumentMetadata(input: PersistDocumentMetadataInput): Promise<{ metadata: ObjectMetadata; replayed: boolean }> {
  validateDocumentOwner(input.userId);
  if (input.stored.objectKey.split('/')[2] !== input.userId) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document object is not tenant-scoped to the authenticated owner');
  try {
    return await withTenant(input.userId, tx => persistDocumentMetadataInTransaction(tx, input));
  } catch (error) {
    // A concurrent creator may win the unique identity race. Re-read in a new
    // transaction because the failed transaction cannot be queried safely.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return withTenant(input.userId, async tx => {
        const concurrent = await tx.objectMetadata.findFirst({
          where: { userId: input.userId, kind: input.stored.kind, checksumSha256: input.stored.checksumSha256 },
        });
        if (!concurrent) throw error;
        if (!sameStoredObject(concurrent, input.stored) || concurrent.resumeId !== (input.resumeId ?? null) || concurrent.resumeVersionId !== (input.resumeVersionId ?? null) || concurrent.deletedAt) {
          throw new DocumentStorageError('CONFLICT', 'A different object already owns this document identity');
        }
        return { metadata: concurrent, replayed: true };
      });
    }
    throw error;
  }
}

export async function approveDocumentMetadataInTransaction(tx: Prisma.TransactionClient, userId: string, objectMetadataId: string): Promise<ObjectMetadata> {
  const object = await tx.objectMetadata.findFirst({ where: { id: objectMetadataId, userId, deletedAt: null, scanStatus: 'CLEAN' } });
  if (!object) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document not found or unavailable');
  requireStoredEncryptionReference(object);
  validateStoredDocumentMetadata(object, { userId });
  const approvedAt = new Date();
  const approved = await tx.objectMetadata.update({
    where: { id: object.id, userId },
    data: { approvalStatus: 'APPROVED', approvedAt, approvedBy: userId },
  });
  await tx.auditLog.create({
    data: {
      userId,
      action: 'DOCUMENT_APPROVED',
      resource: 'ObjectMetadata',
      resourceId: object.id,
      details: { kind: object.kind, checksumSha256: object.checksumSha256, approvedAt: approvedAt.toISOString(), approvedBy: userId },
    },
  });
  return approved;
}

export async function approveDocumentMetadata(userId: string, objectMetadataId: string): Promise<ObjectMetadata> {
  if (!userId.trim() || !objectMetadataId.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner and object identity are required');
  return withTenant(userId, tx => approveDocumentMetadataInTransaction(tx, userId, objectMetadataId));
}

export async function attachDocumentToApplicationInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    applicationId: string;
    resumeVersionId: string;
    objectMetadataId: string;
    type: 'resume' | 'cover_letter' | 'other';
  },
): Promise<{ document: Prisma.ApplicationDocumentGetPayload<Prisma.ApplicationDocumentDefaultArgs>; replayed: boolean }> {
  validateDocumentOwner(input.userId);
  validateDocumentIdentifier(input.applicationId, 'Application identity');
  validateDocumentIdentifier(input.resumeVersionId, 'Resume version identity');
  validateDocumentIdentifier(input.objectMetadataId, 'Object identity');
  if (!['resume', 'cover_letter', 'other'].includes(input.type)) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document attachment type is unsupported');
  const [application, metadata] = await Promise.all([
    tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId }, select: { id: true, resumeVersionId: true } }),
    tx.objectMetadata.findFirst({ where: { id: input.objectMetadataId, userId: input.userId, scanStatus: 'CLEAN', deletedAt: null } }),
  ]);
  if (!application || application.resumeVersionId !== input.resumeVersionId) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Application does not belong to the authenticated owner or resume version');
  }
  if (!metadata || metadata.resumeVersionId !== input.resumeVersionId) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document is not the exact approved object for this resume version');
  }
  if (metadata.approvalStatus !== 'APPROVED' || !(metadata.approvedAt instanceof Date) || !Number.isFinite(metadata.approvedAt.getTime()) || metadata.approvedBy !== input.userId) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document has not been explicitly approved by the authenticated owner');
  }
  requireValidExpiry(metadata.expiresAt);
  const allowedKinds: Record<typeof input.type, readonly DocumentArtifactKind[]> = {
    resume: ['RESUME_SOURCE', 'RESUME_APPROVED', 'RESUME_TAILORED'],
    cover_letter: ['COVER_LETTER'],
    other: ['APPLICATION_EVIDENCE', 'SCREENSHOT', 'RECEIPT'],
  };
  if (!allowedKinds[input.type].includes(metadata.kind as DocumentArtifactKind)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document type is not authorized for this application binding');
  }
  validateStoredDocumentMetadata(metadata, { userId: input.userId, kinds: allowedKinds[input.type] });
  if (metadata.expiresAt && metadata.expiresAt <= new Date()) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document has expired and cannot be attached');
  }
  const existing = await tx.applicationDocument.findFirst({
    where: { applicationId: input.applicationId, objectMetadataId: input.objectMetadataId, type: input.type },
  });
  if (existing) return { document: existing, replayed: true };
  let document: Prisma.ApplicationDocumentGetPayload<Prisma.ApplicationDocumentDefaultArgs>;
  try {
    document = await tx.applicationDocument.create({
      data: {
        applicationId: input.applicationId,
        objectMetadataId: metadata.id,
        type: input.type,
        fileName: metadata.fileName,
        filePath: metadata.objectKey,
        mimeType: metadata.mimeType,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const raced = await tx.applicationDocument.findFirst({ where: { applicationId: input.applicationId, objectMetadataId: metadata.id, type: input.type } });
    if (!raced) throw error;
    return { document: raced, replayed: true };
  }
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: 'DOCUMENT_ATTACHED_TO_APPLICATION',
      resource: 'ApplicationDocument',
      resourceId: document.id,
      details: { applicationId: input.applicationId, resumeVersionId: input.resumeVersionId, objectMetadataId: metadata.id, checksumSha256: metadata.checksumSha256, type: input.type },
    },
  });
  return { document, replayed: false };
}

export interface DocumentScanner {
  scan(buffer: Buffer): Promise<{ status: DocumentScanStatus; engine: string }>;
}

export class ClamAvDocumentScanner implements DocumentScanner {
  constructor(
    private readonly command: string | undefined = process.env.DOCUMENT_SCANNER_COMMAND,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document scanner timeout must be at least one second');
  }

  async scan(buffer: Buffer): Promise<{ status: DocumentScanStatus; engine: string }> {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_DOCUMENT_BYTES) {
      return { status: 'ERROR', engine: 'clamav-input' };
    }
    const command = this.command;
    if (!command) return { status: 'ERROR', engine: 'unconfigured' };
    return new Promise(resolve => {
      const child = spawn(command, ['--no-summary', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      let settled = false;
      const finish = (result: { status: DocumentScanStatus; engine: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish({ status: 'ERROR', engine: 'clamav-timeout' });
      }, this.timeoutMs);
      timeout.unref();
      child.once('error', () => finish({ status: 'ERROR', engine: 'clamav' }));
      child.once('close', (code: number | null) => finish({ status: code === 0 ? 'CLEAN' : code === 1 ? 'INFECTED' : 'ERROR', engine: 'clamav' }));
      child.stdin.end(buffer);
    });
  }
}

function expectedMime(fileName: string): SupportedDocumentMimeType | undefined {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.txt') return 'text/plain';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return undefined;
}

function safeDownloadFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop() ?? 'document';
  const safe = baseName.split('').map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '"' || character === "'" ? '_' : character;
  }).join('').trim();
  return safe.slice(0, 200) || 'document';
}

function hasControlCharacters(value: string): boolean {
  return value.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function isS3BucketName(value: string): boolean {
  return value.length >= 3 && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    && !value.includes('..') && !value.includes('.-') && !value.includes('-.')
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function validateDocumentOwner(userId: string): void {
  if (!userId.trim() || userId !== userId.trim() || userId === '.' || userId === '..'
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(userId)
    || userId.includes('/') || userId.includes('\\') || hasControlCharacters(userId)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner is required and must be a single safe path segment');
  }
}

function validateDocumentIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || hasControlCharacters(value)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', `${name} is required and must be bounded and free of control characters`);
  }
}

function hasExpectedMagic(buffer: Buffer, mimeType: SupportedDocumentMimeType): boolean {
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      && buffer.includes(Buffer.from('[Content_Types].xml')) && buffer.includes(Buffer.from('word/'));
  }
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return !buffer.includes(0) && Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

function validatePrivateObjectKey(objectKey: string): void {
  const pathParts = objectKey.split('/');
  if (!objectKey.startsWith('private/') || pathParts.length !== 4 || !/^[a-f0-9]{64}$/i.test(pathParts[3])) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document key is not a valid private immutable reference');
  }
}

export function validateDocumentUpload(input: { buffer: Buffer; fileName: string; mimeType: string }): { mimeType: SupportedDocumentMimeType; checksumSha256: string } {
  if (!input || typeof input !== 'object' || !Buffer.isBuffer(input.buffer) || typeof input.fileName !== 'string' || typeof input.mimeType !== 'string') {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document upload metadata is invalid');
  }
  if (!input.fileName.trim() || input.fileName.length > 200 || hasControlCharacters(input.fileName)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Document filename must be non-empty, bounded, and free of control characters');
  }
  const mimeType = expectedMime(input.fileName);
  if (!mimeType || input.mimeType !== mimeType) throw new DocumentStorageError('INVALID_DOCUMENT', 'The file extension and declared MIME type must be an approved matching document type');
  if (input.buffer.length === 0 || input.buffer.length > MAX_DOCUMENT_BYTES) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document size must be between 1 byte and 10 MB');
  if (!hasExpectedMagic(input.buffer, mimeType)) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document contents do not match its declared type');
  return { mimeType, checksumSha256: createHash('sha256').update(input.buffer).digest('hex') };
}

export function validateStoredDocumentMetadata(input: {
  userId?: string;
  kind?: string;
  bucket: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  checksumSha256: string;
  byteSize: bigint;
  encryptionKeyRef?: string | null;
}, expected: { userId?: string; kinds?: readonly DocumentArtifactKind[] } = {}): void {
  const pathParts = input.objectKey.split('/');
  const configuredBucket = process.env.S3_DOCUMENT_BUCKET?.trim();
  if (!isS3BucketName(input.bucket) || (configuredBucket && input.bucket !== configuredBucket)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document bucket is not the configured private bucket');
  }
  validatePrivateObjectKey(input.objectKey);
  if (input.kind !== undefined && !DOCUMENT_ARTIFACT_KINDS.includes(input.kind as DocumentArtifactKind)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document kind is unsupported');
  }
  if (input.userId !== undefined) validateDocumentOwner(input.userId);
  if (input.userId !== undefined && pathParts[2] !== input.userId) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document owner does not match its private object path');
  }
  if (expected.userId !== undefined && (input.userId !== expected.userId || pathParts[2] !== expected.userId)) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document is owned by a different user');
  }
  if (expected.kinds && (!input.kind || !expected.kinds.includes(input.kind as DocumentArtifactKind))) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document kind is not authorized for this operation');
  }
  if (input.kind && pathParts[1] !== input.kind.toLowerCase()) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document kind does not match its private object path');
  }
  const expectedType = expectedMime(input.fileName);
  const byteSize = Number(input.byteSize);
  if (input.encryptionKeyRef !== undefined && (!input.encryptionKeyRef || !input.encryptionKeyRef.trim() || input.encryptionKeyRef.length > 500 || hasControlCharacters(input.encryptionKeyRef))) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document encryption metadata is invalid');
  }
  if (!/^[a-f0-9]{64}$/i.test(input.checksumSha256)
    || pathParts[3].toLowerCase() !== input.checksumSha256.toLowerCase()
    || !expectedType || input.mimeType !== expectedType || input.fileName.length < 1 || input.fileName.length > 200 || hasControlCharacters(input.fileName)
    || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_DOCUMENT_BYTES) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document metadata is not a valid private object reference');
  }
}

function requireStoredEncryptionReference(stored: { encryptionKeyRef?: string | null }): void {
  if (!stored.encryptionKeyRef?.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document encryption metadata is missing');
}

function requireApprovedDocument(stored: { approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null }, ownerId: string): void {
  if (stored.approvalStatus !== 'APPROVED' || !(stored.approvedAt instanceof Date) || !Number.isFinite(stored.approvedAt.getTime()) || stored.approvedBy !== ownerId) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Only an explicitly owner-approved document may be read by a worker');
  }
}

function requireValidExpiry(value: Date | null | undefined): void {
  if (value !== undefined && value !== null && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
    throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document expiry metadata is invalid');
  }
}

function matchesStoredEncryption(response: { ServerSideEncryption?: string; SSEKMSKeyId?: string }, encryptionKeyRef: string): boolean {
  return encryptionKeyRef === 'S3_MANAGED'
    ? response.ServerSideEncryption === 'AES256'
    : response.ServerSideEncryption === 'aws:kms' && response.SSEKMSKeyId === encryptionKeyRef;
}

function storageConfig(): { bucket: string; client: S3Client; encryptionKeyRef: string } {
  const bucket = process.env.S3_DOCUMENT_BUCKET?.trim();
  if (!bucket) throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage is not configured');
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const encryptionKeyRef = process.env.S3_KMS_KEY_ID?.trim() || 'S3_MANAGED';
  if (endpoint) {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'S3 endpoint is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'S3 endpoint must not contain credentials or query data');
    }
  }
  if (!isS3BucketName(bucket)) {
    throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document bucket is invalid');
  }
  if (Array.from(encryptionKeyRef).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || encryptionKeyRef.length > 500) {
    throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Document encryption configuration is invalid');
  }
  return {
    bucket,
    encryptionKeyRef,
    client: new S3Client({ region: process.env.S3_REGION?.trim() || 'us-east-1', endpoint: endpoint || undefined, forcePathStyle: Boolean(endpoint) }),
  };
}

export class DocumentStorage {
  constructor(private readonly scanner: DocumentScanner = new ClamAvDocumentScanner(), private readonly config = storageConfig) {}

  async storeResume(input: { userId: string; fileName: string; mimeType: string; buffer: Buffer }): Promise<StoredDocument> {
    return this.storeArtifact({ ...input, kind: 'RESUME_SOURCE' });
  }

  async storeArtifact(input: { userId: string; kind: DocumentArtifactKind; fileName: string; mimeType: string; buffer: Buffer }): Promise<StoredDocument> {
    validateDocumentOwner(input.userId);
    if (!DOCUMENT_ARTIFACT_KINDS.includes(input.kind)) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document artifact kind is unsupported');
    const validated = validateDocumentUpload(input);
    const scan = await this.scanner.scan(input.buffer);
    if (scan.status === 'ERROR') throw new DocumentStorageError('SCAN_UNAVAILABLE', 'Document malware scanning is unavailable');
    if (scan.status === 'INFECTED') throw new DocumentStorageError('MALWARE_DETECTED', 'Document was rejected by malware scanning');
    const { bucket, client, encryptionKeyRef } = this.config();
    // Content-addressed within the tenant and artifact class: retries and concurrent
    // identical uploads converge on the same immutable object identity.
    const objectKey = `private/${input.kind.toLowerCase()}/${input.userId}/${validated.checksumSha256}`;
    try {
      const result = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: input.buffer,
        ContentType: validated.mimeType,
        // Content-addressed objects are immutable. A duplicate upload must
        // never replace an existing object (including a versioned one).
        IfNoneMatch: '*',
        Metadata: { sha256: validated.checksumSha256 },
        ChecksumSHA256: Buffer.from(validated.checksumSha256, 'hex').toString('base64'),
        ServerSideEncryption: encryptionKeyRef === 'S3_MANAGED' ? 'AES256' : 'aws:kms',
        SSEKMSKeyId: encryptionKeyRef === 'S3_MANAGED' ? undefined : encryptionKeyRef,
      }));
      return { kind: input.kind, bucket, objectKey, versionId: result.VersionId, fileName: input.fileName, mimeType: validated.mimeType, byteSize: input.buffer.length, checksumSha256: validated.checksumSha256, encryptionKeyRef, scanStatus: 'CLEAN', scanDetails: { engine: scan.engine, scannedAt: new Date().toISOString() } };
    } catch (error) {
      // S3-compatible stores report the immutable-write race as a failed
      // conditional put. Reconcile only when the existing object advertises
      // the exact same content hash and size; all other failures remain hard
      // storage failures.
      try {
        const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        if (existing.ContentLength === input.buffer.length && existing.ContentType === validated.mimeType
          && existing.Metadata?.sha256?.toLowerCase() === validated.checksumSha256.toLowerCase()
          && (encryptionKeyRef === 'S3_MANAGED'
            ? existing.ServerSideEncryption === 'AES256'
            : existing.ServerSideEncryption === 'aws:kms' && existing.SSEKMSKeyId === encryptionKeyRef)) {
          return { kind: input.kind, bucket, objectKey, versionId: existing.VersionId, fileName: input.fileName, mimeType: validated.mimeType, byteSize: input.buffer.length, checksumSha256: validated.checksumSha256, encryptionKeyRef, scanStatus: 'CLEAN', scanDetails: { engine: scan.engine, scannedAt: new Date().toISOString() } };
        }
      } catch {
        // Preserve the original storage failure below.
      }
      throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage could not store the upload');
    }
  }

  async storeAndPersistArtifact(input: {
    userId: string;
    kind: DocumentArtifactKind;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    resumeId?: string;
    resumeVersionId?: string;
    provenance?: Record<string, unknown>;
  }): Promise<{ stored: StoredDocument; metadata: ObjectMetadata; replayed: boolean }> {
    const stored = await this.storeArtifact(input);
    // Content-addressed objects may already back a committed upload, including
    // a concurrent request. A failed/uncertain DB commit never proves exclusive
    // ownership: retain the private object for retry, not compensating deletion.
    const persisted = await persistDocumentMetadata({
      userId: input.userId,
      stored,
      resumeId: input.resumeId,
      resumeVersionId: input.resumeVersionId,
      provenance: input.provenance,
    });
    return { stored, ...persisted };
  }

  async readVerified(stored: { bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; encryptionKeyRef?: string | null }): Promise<{ buffer: Buffer; fileName: string; mimeType: SupportedDocumentMimeType }> {
    requireStoredEncryptionReference(stored);
    validateStoredDocumentMetadata(stored);
    const expectedBytes = Number(stored.byteSize);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_DOCUMENT_BYTES) {
      throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document metadata has an invalid size');
    }
    const expectedType = expectedMime(stored.fileName);
    if (!expectedType || expectedType !== stored.mimeType) {
      throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document metadata has an invalid MIME type');
    }
    try {
      const { client, bucket } = this.config();
      if (stored.bucket !== bucket) throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document belongs to a different private bucket');
      const head = await client.send(new HeadObjectCommand({ Bucket: stored.bucket, Key: stored.objectKey, VersionId: stored.versionId ?? undefined }));
      if (!matchesStoredEncryption(head, stored.encryptionKeyRef!)) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document encryption does not match its immutable metadata');
      }
      if (head.ContentLength !== expectedBytes) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document size does not match its immutable metadata');
      }
      if (head.ContentType !== expectedType) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document MIME type does not match its immutable metadata');
      }
      if (head.Metadata?.sha256?.toLowerCase() !== stored.checksumSha256.toLowerCase()) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document checksum metadata does not match its immutable metadata');
      }
      const response = await client.send(new GetObjectCommand({ Bucket: stored.bucket, Key: stored.objectKey, VersionId: stored.versionId ?? undefined }));
      if (!response.Body) throw new Error('empty object');
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const checksum = createHash('sha256').update(buffer).digest('hex');
      if (buffer.length !== expectedBytes || checksum.toLowerCase() !== stored.checksumSha256.toLowerCase() || !hasExpectedMagic(buffer, expectedType)) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document integrity verification failed');
      }
      return { buffer, fileName: stored.fileName, mimeType: expectedType };
    } catch (error) {
      if (error instanceof DocumentStorageError) throw error;
      throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage could not read the verified upload');
    }
  }

  /**
   * Worker-facing read boundary. A document reference is not sufficient by
   * itself: callers must bind it to the authenticated tenant owner before any
   * object-store request is issued.
   */
  async readAuthorized(userId: string, stored: { userId?: string; kind?: string; bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; encryptionKeyRef?: string | null; approvalStatus?: string; approvedAt?: Date | null; approvedBy?: string | null; scanStatus?: string; deletedAt?: Date | null; expiresAt?: Date | null }): Promise<{ buffer: Buffer; fileName: string; mimeType: SupportedDocumentMimeType }> {
    if (!userId.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner is required');
    if (stored.userId !== userId) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document metadata is not owned by the authenticated user');
    if (stored.scanStatus !== undefined && stored.scanStatus !== 'CLEAN') throw new DocumentStorageError('INVALID_DOCUMENT', 'Only clean documents may be read');
    if (stored.deletedAt !== undefined && stored.deletedAt !== null) throw new DocumentStorageError('INVALID_DOCUMENT', 'Deleted documents may not be read');
    requireValidExpiry(stored.expiresAt);
    if (stored.expiresAt !== undefined && stored.expiresAt !== null && stored.expiresAt <= new Date()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Expired documents may not be read');
    requireApprovedDocument(stored, userId);
    requireStoredEncryptionReference(stored);
    if (!stored.kind || !DOCUMENT_ARTIFACT_KINDS.includes(stored.kind as DocumentArtifactKind)) {
      throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document artifact type is required for worker access');
    }
    validateStoredDocumentMetadata(stored, { userId, kinds: [stored.kind as DocumentArtifactKind] });
    return this.readVerified(stored);
  }

  async delete(stored: { bucket: string; objectKey: string; versionId?: string | null }): Promise<void> {
    validatePrivateObjectKey(stored.objectKey);
    const { client, bucket } = this.config();
    if (stored.bucket !== bucket) throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document belongs to a different private bucket');
    try {
      await client.send(new DeleteObjectCommand({ Bucket: stored.bucket, Key: stored.objectKey, VersionId: stored.versionId ?? undefined }));
    } catch (error) {
      // Deletion is intentionally idempotent: a worker crash after the object
      // store committed must not turn the retry into a permanent failure.
      const code = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
      const status = error && typeof error === 'object' && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode) : undefined;
      if (code !== 'NoSuchKey' && code !== 'NotFound' && status !== 404) throw error;
    }
  }

  async deleteAuthorized(userId: string, stored: { userId?: string; bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; encryptionKeyRef?: string | null }): Promise<void> {
    if (!userId.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner is required');
    if (stored.userId !== userId) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document metadata is not owned by the authenticated user');
    requireStoredEncryptionReference(stored);
    validateStoredDocumentMetadata(stored, { userId });
    await this.delete(stored);
  }

  async signedDownloadUrl(userId: string, stored: { userId?: string; bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; encryptionKeyRef?: string | null; scanStatus: string; deletedAt: Date | null; expiresAt: Date | null }): Promise<string> {
    if (!userId.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner is required');
    if (stored.userId !== userId) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document metadata is not owned by the authenticated user');
    if (stored.scanStatus !== 'CLEAN') throw new DocumentStorageError('INVALID_DOCUMENT', 'Only clean documents may be signed');
    if (stored.deletedAt !== null) throw new DocumentStorageError('INVALID_DOCUMENT', 'Deleted documents may not be signed');
    requireValidExpiry(stored.expiresAt);
    if (stored.expiresAt !== null && stored.expiresAt <= new Date()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Expired documents may not be signed');
    requireStoredEncryptionReference(stored);
    validateStoredDocumentMetadata(stored, { userId });
    await this.readVerified(stored);
    return this.createSignedDownloadUrl(stored);
  }

  private async createSignedDownloadUrl(stored: { bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string }): Promise<string> {
    const { client, bucket } = this.config();
    if (stored.bucket !== bucket) throw new DocumentStorageError('INVALID_DOCUMENT', 'Stored document belongs to a different private bucket');
    return getSignedUrl(client, new GetObjectCommand({
      Bucket: stored.bucket,
      Key: stored.objectKey,
      VersionId: stored.versionId ?? undefined,
      ResponseContentType: stored.mimeType,
      ResponseContentDisposition: `attachment; filename="${safeDownloadFileName(stored.fileName)}"`,
      ResponseCacheControl: 'no-store',
    }), { expiresIn: DOWNLOAD_TTL_SECONDS });
  }

  async signedDownloadUrlAuthorized(userId: string, stored: { userId?: string; bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string; checksumSha256: string; byteSize: bigint; encryptionKeyRef?: string | null; scanStatus?: string; deletedAt?: Date | null; expiresAt?: Date | null }): Promise<string> {
    if (!userId.trim()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document owner is required');
    if (stored.userId !== userId) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document metadata is not owned by the authenticated user');
    if (stored.scanStatus !== undefined && stored.scanStatus !== 'CLEAN') throw new DocumentStorageError('INVALID_DOCUMENT', 'Only clean documents may be signed');
    if (stored.deletedAt !== undefined && stored.deletedAt !== null) throw new DocumentStorageError('INVALID_DOCUMENT', 'Deleted documents may not be signed');
    requireValidExpiry(stored.expiresAt);
    if (stored.expiresAt !== undefined && stored.expiresAt !== null && stored.expiresAt <= new Date()) throw new DocumentStorageError('INVALID_DOCUMENT', 'Expired documents may not be signed');
    requireStoredEncryptionReference(stored);
    validateStoredDocumentMetadata(stored, { userId });
    // A signed URL bypasses this service on download. Verify the immutable
    // object before issuing access so metadata that still says CLEAN cannot
    // authorize a tampered object.
    await this.readVerified(stored);
    return this.createSignedDownloadUrl(stored);
  }
}
