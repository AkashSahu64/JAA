import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRefreshToken, verifyRefreshToken, verifyToken } from '@jobagent/security';
import { refreshTokenHash, revokeRefreshSessionFamily, rotateRefreshSession } from './refresh-sessions';

const mocks = vi.hoisted(() => {
  const tx = { $executeRaw: vi.fn(), refreshTokenSession: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() }, auditLog: { create: vi.fn() } };
  return { tx, committed: false, withTenant: vi.fn() };
});
vi.mock('@jobagent/database', () => ({ withTenant: mocks.withTenant }));

const owner = { userId: 'owner-1', email: 'owner@example.invalid' };
let presented: string;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('JWT_SECRET', 'refresh-tests-only-secret-32-characters');
  presented = generateRefreshToken(owner);
  mocks.committed = false;
  mocks.withTenant.mockImplementation(async (_owner: string, operation: (tx: typeof mocks.tx) => Promise<unknown>) => {
    const result = await operation(mocks.tx);
    mocks.committed = true;
    return result;
  });
  mocks.tx.refreshTokenSession.findFirst.mockResolvedValue({ id: 'session-1', familyId: 'family-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
});
afterEach(() => vi.unstubAllEnvs());

describe('refresh session transaction boundary', () => {
  it('rotates into a distinct hashed successor and returns tokens only after commit', async () => {
    const result = await rotateRefreshSession(presented);
    expect(mocks.committed).toBe(true);
    expect(result.refreshToken).not.toBe(presented);
    expect(verifyRefreshToken(result.refreshToken)).toEqual(owner);
    expect(verifyToken(result.token)).toEqual(owner);
    expect(mocks.tx.refreshTokenSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: owner.userId, familyId: 'family-1', tokenHash: refreshTokenHash(result.refreshToken) }) });
  });

  it('commits reuse revocation and its audit before rejecting the refresh', async () => {
    mocks.tx.refreshTokenSession.findFirst.mockResolvedValue({ id: 'session-1', familyId: 'family-1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await expect(rotateRefreshSession(presented)).rejects.toMatchObject({ name: 'RefreshSessionError' });
    expect(mocks.committed).toBe(true);
    expect(mocks.tx.refreshTokenSession.updateMany).toHaveBeenCalledWith({ where: { userId: owner.userId, familyId: 'family-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'AUTH_REFRESH_REUSE_DETECTED', userId: owner.userId }) });
    expect(mocks.tx.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('propagates persistence failures instead of returning tokens or an invalid-credential result', async () => {
    mocks.tx.refreshTokenSession.create.mockRejectedValue(new Error('database unavailable'));
    await expect(rotateRefreshSession(presented)).rejects.toThrow('database unavailable');
    expect(mocks.committed).toBe(false);
  });

  it('does not access durable sessions for an invalid signature', async () => {
    await expect(rotateRefreshSession('invalid')).rejects.toMatchObject({ name: 'RefreshSessionError' });
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects inactive or unknown sessions without creating a replacement', async () => {
    mocks.tx.refreshTokenSession.findFirst.mockResolvedValue(null);
    await expect(rotateRefreshSession(presented)).rejects.toMatchObject({ name: 'RefreshSessionError' });
    expect(mocks.tx.refreshTokenSession.findFirst).toHaveBeenCalledWith({ where: { userId: owner.userId, tokenHash: refreshTokenHash(presented), user: { isActive: true } } });
    expect(mocks.tx.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('serializes logout with rotation and revokes the whole family even from an old token', async () => {
    await rotateRefreshSession(presented);
    const rotationLock = mocks.tx.$executeRaw.mock.calls[0];
    mocks.tx.$executeRaw.mockClear();
    await revokeRefreshSessionFamily(owner.userId, presented);
    expect(mocks.tx.$executeRaw.mock.calls[0]).toEqual(rotationLock);
    expect(mocks.tx.refreshTokenSession.updateMany).toHaveBeenCalledWith({ where: { userId: owner.userId, familyId: 'family-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it('does not revoke or audit another owner’s token', async () => {
    mocks.tx.refreshTokenSession.findFirst.mockResolvedValue(null);
    await revokeRefreshSessionFamily('other-owner', presented);
    expect(mocks.tx.refreshTokenSession.findFirst).toHaveBeenCalledWith({ where: { userId: 'other-owner', tokenHash: refreshTokenHash(presented) } });
    expect(mocks.tx.refreshTokenSession.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
