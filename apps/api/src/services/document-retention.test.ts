import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({ prisma: { objectMetadata: mocks } }));

import { purgeExpiredDocuments } from './document-retention';

describe('document retention', () => {
  afterEach(() => vi.clearAllMocks());

  it('deletes expired non-held objects and records the deletion timestamp', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'expired', bucket: 'private', objectKey: 'key', versionId: null }]);
    mocks.update.mockResolvedValue({});
    const storage = { delete: vi.fn(async () => undefined) };
    const now = new Date('2026-09-11T00:00:00.000Z');

    await expect(purgeExpiredDocuments(storage, now)).resolves.toEqual({ deleted: 1, failedObjectIds: [] });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now }, deletedAt: null, legalHold: false },
      select: { id: true, bucket: true, objectKey: true, versionId: true },
    });
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'expired' }, data: { deletedAt: now } });
  });

  it('does not mark metadata deleted when the object store deletion fails', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'expired', bucket: 'private', objectKey: 'key', versionId: 'v1' }]);
    const storage = { delete: vi.fn(async () => { throw new Error('offline'); }) };

    await expect(purgeExpiredDocuments(storage)).resolves.toEqual({ deleted: 0, failedObjectIds: ['expired'] });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
