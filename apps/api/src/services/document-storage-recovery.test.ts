import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('@jobagent/database', () => db);
import { DocumentStorage, DocumentStorageError } from './document-storage';

describe('immutable upload metadata failure recovery', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    new Error('database commit outcome unknown'),
    new DocumentStorageError('CONFLICT', 'another version owns this identity'),
  ])('never deletes a shared object when persistence rejects: %s', async failure => {
    const client = { send: vi.fn().mockResolvedValue({ VersionId: 'immutable-version' }) };
    const storage = new DocumentStorage(
      { scan: async () => ({ status: 'CLEAN', engine: 'fixture' }) },
      () => ({ bucket: 'private', client: client as never, encryptionKeyRef: 'S3_MANAGED' }),
    );
    db.withTenant.mockRejectedValueOnce(failure);
    const input = { userId: 'user-1', kind: 'COVER_LETTER' as const, fileName: 'cover.txt', mimeType: 'text/plain', buffer: Buffer.from('Approved cover letter') };
    await expect(storage.storeAndPersistArtifact(input)).rejects.toBe(failure);
    expect(client.send).toHaveBeenCalledOnce();
    expect(client.send.mock.calls[0][0].constructor.name).toBe('PutObjectCommand');

    db.withTenant.mockResolvedValueOnce({ metadata: { id: 'object-1' }, replayed: true });
    await expect(storage.storeAndPersistArtifact(input)).resolves.toMatchObject({ metadata: { id: 'object-1' }, replayed: true });
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[0][0].input.Key).toBe(client.send.mock.calls[1][0].input.Key);
  });
});
