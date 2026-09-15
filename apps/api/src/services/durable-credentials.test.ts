import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ credentialFindFirst: vi.fn(), credentialUpdateMany: vi.fn(), emailUpdateMany: vi.fn(), auditCreate: vi.fn(), credentialFindFirstOrThrow: vi.fn() }));
vi.mock('@jobagent/database', () => ({
  withTenant: async (_userId: string, operation: (tx: unknown) => unknown) => operation({
    credentialRecord: { findFirst: mocks.credentialFindFirst, updateMany: mocks.credentialUpdateMany, findFirstOrThrow: mocks.credentialFindFirstOrThrow },
    emailConnection: { updateMany: mocks.emailUpdateMany },
    auditLog: { create: mocks.auditCreate },
  }),
}));
import { retrieveDurableCredential, revokeDurableCredential, validateCredentialRecordInput } from './durable-credentials';

describe('durable credential boundary', () => {
  it('accepts bounded credential metadata without persisting plaintext by contract', () => {
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: 'greenhouse-session', value: 'secret' })).not.toThrow();
  });
  it('rejects invalid owners, blank names, and oversized values', () => {
    expect(() => validateCredentialRecordInput({ userId: 'tenant/a', name: 'x', value: 'secret' })).toThrow('owner');
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: ' ', value: 'secret' })).toThrow('name');
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: 'x', value: 'x'.repeat(100_001) })).toThrow('value');
  });

  it('rejects malformed runtime records without leaking TypeError', () => {
    expect(() => validateCredentialRecordInput({ userId: 42 as never, name: 'x', value: 'secret' })).toThrow('owner');
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: 42 as never, value: 'secret' })).toThrow('name');
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: 'x', value: 42 as never })).toThrow('value');
  });

  it('fails closed for malformed credential identities before database access', async () => {
    await expect(retrieveDurableCredential('tenant-a', 42 as never)).resolves.toBeNull();
    await expect(revokeDurableCredential('tenant-a', 42 as never)).rejects.toThrow('identity');
  });

  it('rejects control characters before durable credential access', async () => {
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a\n', name: 'mailbox', value: 'secret' })).toThrow('owner');
    expect(() => validateCredentialRecordInput({ userId: 'tenant-a', name: 'mailbox\r', value: 'secret' })).toThrow('name');
    await expect(retrieveDurableCredential('tenant-a', 'credential-1\r')).resolves.toBeNull();
    await expect(revokeDurableCredential('tenant-a\n', 'credential-1')).rejects.toThrow('identity');
  });

  it('revokes active email connections when their credential is revoked', async () => {
    mocks.credentialUpdateMany.mockResolvedValue({ count: 1 });
    mocks.emailUpdateMany.mockResolvedValue({ count: 2 });
    mocks.credentialFindFirstOrThrow.mockResolvedValue({ id: 'credential-1', name: 'mailbox', version: 2, revokedAt: new Date() });
    await expect(revokeDurableCredential('tenant-a', 'credential-1')).resolves.toMatchObject({ id: 'credential-1' });
    expect(mocks.emailUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'tenant-a', credentialRef: 'credential-1', status: 'ACTIVE' }, data: expect.objectContaining({ status: 'REVOKED', credentialRef: null }) }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'CREDENTIAL_REVOKED', details: expect.objectContaining({ dependentEmailConnectionsRevoked: 2 }) }) }));
  });

  it('refreshes a retrieved credential only within the owner and live-record boundary', async () => {
    mocks.credentialFindFirst.mockResolvedValue({ encryptedValue: 'encrypted-secret' });
    mocks.credentialUpdateMany.mockResolvedValue({ count: 0 });
    await expect(retrieveDurableCredential('tenant-a', 'credential-1')).resolves.toBeNull();
    expect(mocks.credentialUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'credential-1', userId: 'tenant-a', revokedAt: null } }));
  });
});
