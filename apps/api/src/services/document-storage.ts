import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export type SupportedDocumentMimeType = 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain';
export type DocumentScanStatus = 'CLEAN' | 'INFECTED' | 'ERROR';

export interface StoredDocument {
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
  constructor(public readonly code: 'INVALID_DOCUMENT' | 'SCAN_UNAVAILABLE' | 'MALWARE_DETECTED' | 'STORAGE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'DocumentStorageError';
  }
}

export interface DocumentScanner {
  scan(buffer: Buffer): Promise<{ status: DocumentScanStatus; engine: string }>;
}

export class ClamAvDocumentScanner implements DocumentScanner {
  constructor(private readonly command: string | undefined = process.env.DOCUMENT_SCANNER_COMMAND) {}

  async scan(buffer: Buffer): Promise<{ status: DocumentScanStatus; engine: string }> {
    const command = this.command;
    if (!command) return { status: 'ERROR', engine: 'unconfigured' };
    return new Promise(resolve => {
      const child = spawn(command, ['--no-summary', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => resolve({ status: 'ERROR', engine: 'clamav' }));
      child.once('close', (code: number | null) => resolve({ status: code === 0 ? 'CLEAN' : code === 1 ? 'INFECTED' : 'ERROR', engine: 'clamav' }));
      child.stdin.end(buffer);
    });
  }
}

function expectedMime(fileName: string): SupportedDocumentMimeType | undefined {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.txt') return 'text/plain';
  return undefined;
}

function hasExpectedMagic(buffer: Buffer, mimeType: SupportedDocumentMimeType): boolean {
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      && buffer.includes(Buffer.from('[Content_Types].xml')) && buffer.includes(Buffer.from('word/'));
  }
  return !buffer.includes(0) && Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

export function validateDocumentUpload(input: { buffer: Buffer; fileName: string; mimeType: string }): { mimeType: SupportedDocumentMimeType; checksumSha256: string } {
  const mimeType = expectedMime(input.fileName);
  if (!mimeType || input.mimeType !== mimeType) throw new DocumentStorageError('INVALID_DOCUMENT', 'The file extension and declared MIME type must be an approved matching document type');
  if (input.buffer.length === 0 || input.buffer.length > MAX_DOCUMENT_BYTES) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document size must be between 1 byte and 10 MB');
  if (!hasExpectedMagic(input.buffer, mimeType)) throw new DocumentStorageError('INVALID_DOCUMENT', 'Document contents do not match its declared type');
  return { mimeType, checksumSha256: createHash('sha256').update(input.buffer).digest('hex') };
}

function storageConfig(): { bucket: string; client: S3Client; encryptionKeyRef: string } {
  const bucket = process.env.S3_DOCUMENT_BUCKET?.trim();
  if (!bucket) throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage is not configured');
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const encryptionKeyRef = process.env.S3_KMS_KEY_ID?.trim() || 'S3_MANAGED';
  return {
    bucket,
    encryptionKeyRef,
    client: new S3Client({ region: process.env.S3_REGION?.trim() || 'us-east-1', endpoint: endpoint || undefined, forcePathStyle: Boolean(endpoint) }),
  };
}

export class DocumentStorage {
  constructor(private readonly scanner: DocumentScanner = new ClamAvDocumentScanner(), private readonly config = storageConfig) {}

  async storeResume(input: { userId: string; fileName: string; mimeType: string; buffer: Buffer }): Promise<StoredDocument> {
    const validated = validateDocumentUpload(input);
    const scan = await this.scanner.scan(input.buffer);
    if (scan.status === 'ERROR') throw new DocumentStorageError('SCAN_UNAVAILABLE', 'Document malware scanning is unavailable');
    if (scan.status === 'INFECTED') throw new DocumentStorageError('MALWARE_DETECTED', 'Document was rejected by malware scanning');
    const { bucket, client, encryptionKeyRef } = this.config();
    const objectKey = `private/resumes/${input.userId}/${randomUUID()}`;
    try {
      const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: input.buffer, ContentType: validated.mimeType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: encryptionKeyRef === 'S3_MANAGED' ? undefined : encryptionKeyRef }));
      return { bucket, objectKey, versionId: result.VersionId, fileName: input.fileName, mimeType: validated.mimeType, byteSize: input.buffer.length, checksumSha256: validated.checksumSha256, encryptionKeyRef, scanStatus: 'CLEAN', scanDetails: { engine: scan.engine, scannedAt: new Date().toISOString() } };
    } catch {
      throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage could not store the upload');
    }
  }

  async delete(stored: { bucket: string; objectKey: string; versionId?: string | null }): Promise<void> {
    const { client } = this.config();
    await client.send(new DeleteObjectCommand({ Bucket: stored.bucket, Key: stored.objectKey, VersionId: stored.versionId ?? undefined }));
  }

  async signedDownloadUrl(stored: { bucket: string; objectKey: string; versionId?: string | null; fileName: string; mimeType: string }): Promise<string> {
    const { client } = this.config();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: stored.bucket, Key: stored.objectKey, VersionId: stored.versionId ?? undefined, ResponseContentType: stored.mimeType, ResponseContentDisposition: `attachment; filename="${stored.fileName}"` }), { expiresIn: DOWNLOAD_TTL_SECONDS });
  }
}
