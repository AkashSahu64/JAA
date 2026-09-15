import { afterAll, describe, expect, it } from 'vitest';
import { DocumentStorage, type DocumentScanner } from './document-storage';

const enabled = process.env.S3_INTEGRATION === '1'
  && Boolean(process.env.S3_DOCUMENT_BUCKET)
  && Boolean(process.env.S3_ENDPOINT);
const describeS3 = enabled ? describe : describe.skip;
const scanner: DocumentScanner = { scan: async () => ({ status: 'CLEAN', engine: 'integration-fixture' }) };
const pdf = Buffer.from('%PDF-1.7\nS3 integration fixture');

describeS3.sequential('private S3-compatible document storage', () => {
  const storage = new DocumentStorage(scanner);
  const userId = `s3-integration-${process.pid}`;
  let stored: Awaited<ReturnType<typeof storage.storeArtifact>>;

  afterAll(async () => {
    if (stored) await storage.delete(stored);
  });

  it('uploads and reads back a checksum-verified private object', async () => {
    stored = await storage.storeArtifact({ userId, kind: 'APPLICATION_EVIDENCE', fileName: 'evidence.pdf', mimeType: 'application/pdf', buffer: pdf });
    await expect(storage.readVerified({ ...stored, byteSize: BigInt(stored.byteSize) }))
      .resolves.toEqual({ buffer: pdf, fileName: 'evidence.pdf', mimeType: 'application/pdf' });
  });

  it('converges concurrent identical uploads on one content-addressed identity', async () => {
    const results = await Promise.all([
      storage.storeArtifact({ userId, kind: 'SCREENSHOT', fileName: 'screen.pdf', mimeType: 'application/pdf', buffer: pdf }),
      storage.storeArtifact({ userId, kind: 'SCREENSHOT', fileName: 'screen.pdf', mimeType: 'application/pdf', buffer: pdf }),
    ]);
    expect(results[0].objectKey).toBe(results[1].objectKey);
    await storage.delete(results[0]);
  });

  it('requires the owner for signed access and rejects tampered metadata', async () => {
    const ownerDocument = { ...stored, userId };
    await expect(storage.signedDownloadUrlAuthorized(userId, { ...ownerDocument, byteSize: BigInt(stored.byteSize) }))
      .resolves.toMatch(/X-Amz-Expires=300/);
    await expect(storage.signedDownloadUrlAuthorized(`${userId}-other`, { ...ownerDocument, byteSize: BigInt(stored.byteSize) }))
      .rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    await expect(storage.readVerified({ ...stored, byteSize: BigInt(stored.byteSize), checksumSha256: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });
});
