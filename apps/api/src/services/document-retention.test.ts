import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  $executeRaw: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  withService: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({
  withService: mocks.withService,
}));

import { purgeExpiredDocuments } from './document-retention';

describe('document retention', () => {
  beforeEach(() => {
    mocks.findFirst.mockResolvedValue({ id: 'expired' });
    mocks.$executeRaw.mockResolvedValue(undefined);
    mocks.withService.mockImplementation(async (operation: (tx: { objectMetadata: typeof mocks; auditLog: typeof mocks; $executeRaw: typeof mocks.$executeRaw }) => Promise<unknown>) => operation({ objectMetadata: mocks, auditLog: mocks, $executeRaw: mocks.$executeRaw }));
  });
  afterEach(() => vi.clearAllMocks());

  it('rejects malformed retention timestamps before querying metadata', async () => {
    await expect(purgeExpiredDocuments({ deleteAuthorized: vi.fn() }, new Date(Number.NaN))).rejects.toThrow('Document retention time must be a valid Date');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('deletes expired non-held objects and records the deletion timestamp', async () => {
    const objectKey = 'private/screenshot/user-1/' + 'a'.repeat(64);
    mocks.findMany.mockResolvedValue([{ id: 'expired', userId: 'user-1', bucket: 'private', objectKey, versionId: null, fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'a'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const storage = { deleteAuthorized: vi.fn(async () => undefined) };
    const now = new Date('2026-09-11T00:00:00.000Z');

    await expect(purgeExpiredDocuments(storage, now)).resolves.toEqual({ deleted: 1, failedObjectIds: [] });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now }, deletedAt: null, legalHold: false },
      select: { id: true, userId: true, bucket: true, objectKey: true, versionId: true, fileName: true, mimeType: true, checksumSha256: true, byteSize: true, encryptionKeyRef: true },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'expired', userId: 'user-1', deletedAt: null }, data: { deletedAt: now } });
    expect(storage.deleteAuthorized).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: 'expired', objectKey }));
    expect(mocks.$executeRaw).toHaveBeenCalledOnce();
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'expired', deletedAt: null, legalHold: false }) }));
    expect(mocks.create).toHaveBeenCalledWith({ data: { userId: 'user-1', action: 'DOCUMENT_DELETED_RETENTION', resource: 'ObjectMetadata', resourceId: 'expired', details: { bucket: 'private', objectKey, checksumSha256: 'a'.repeat(64), deletedAt: now.toISOString() } } });
  });

  it('does not mark metadata deleted when the object store deletion fails', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'expired', userId: 'user-1', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'b'.repeat(64), versionId: 'v1', fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'b'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' }]);
    const storage = { deleteAuthorized: vi.fn(async () => { throw new Error('offline'); }) };

    await expect(purgeExpiredDocuments(storage)).resolves.toEqual({ deleted: 0, failedObjectIds: ['expired'] });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('skips an object already tombstoned by another retention worker after locking', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'expired', userId: 'user-1', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'c'.repeat(64), versionId: null, fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'c'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' }]);
    mocks.findFirst.mockResolvedValueOnce(null);
    const storage = { deleteAuthorized: vi.fn(async () => undefined) };

    await expect(purgeExpiredDocuments(storage, new Date('2026-09-11T00:00:00.000Z'))).resolves.toEqual({ deleted: 0, failedObjectIds: [] });
    expect(storage.deleteAuthorized).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not overwrite an owner tombstone after deleting the object', async () => {
    const objectKey = 'private/screenshot/user-1/' + 'd'.repeat(64);
    mocks.findMany.mockResolvedValue([{ id: 'expired', userId: 'user-1', bucket: 'private', objectKey, versionId: null, fileName: 'evidence.png', mimeType: 'image/png', checksumSha256: 'd'.repeat(64), byteSize: BigInt(42), encryptionKeyRef: 'S3_MANAGED' }]);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const storage = { deleteAuthorized: vi.fn(async () => undefined) };

    await expect(purgeExpiredDocuments(storage, new Date('2026-09-11T00:00:00.000Z')))
      .resolves.toEqual({ deleted: 0, failedObjectIds: [] });
    expect(storage.deleteAuthorized).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
