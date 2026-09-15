import { createHash } from 'node:crypto';
import { withTenant } from '@jobagent/database';
import { generateRefreshToken, generateToken, verifyRefreshToken } from '@jobagent/security';

export class RefreshSessionError extends Error {
  constructor() { super('Invalid or expired refresh token'); this.name = 'RefreshSessionError'; }
}

export function refreshTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function rotateRefreshSession(presentedToken: string) {
  let payload: ReturnType<typeof verifyRefreshToken>;
  try { payload = verifyRefreshToken(presentedToken); } catch { throw new RefreshSessionError(); }
  const hash = refreshTokenHash(presentedToken);
  const result = await withTenant(payload.userId, async tx => {
    // All rotations and logout for this owner share a lock, including different
    // generations in the same family. No successor may escape family revocation.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${payload.userId}:refresh-sessions`}, 0))`;
    const now = new Date();
    const current = await tx.refreshTokenSession.findFirst({
      where: { userId: payload.userId, tokenHash: hash, user: { isActive: true } },
    });
    if (!current || current.expiresAt <= now) return null;
    if (current.revokedAt) {
      await tx.refreshTokenSession.updateMany({
        where: { userId: payload.userId, familyId: current.familyId, revokedAt: null }, data: { revokedAt: now },
      });
      await tx.auditLog.create({ data: {
        userId: payload.userId, action: 'AUTH_REFRESH_REUSE_DETECTED', resource: 'refresh_token_session',
        resourceId: current.id, details: { familyRevoked: true },
      } });
      // Return a rejected outcome so the revocation/audit COMMIT before the
      // caller returns 401. Throwing here would roll both changes back.
      return null;
    }
    const refreshToken = generateRefreshToken(payload);
    const token = generateToken(payload);
    await tx.refreshTokenSession.update({ where: { id: current.id }, data: { revokedAt: now, lastUsedAt: now } });
    await tx.refreshTokenSession.create({ data: {
      userId: payload.userId, tokenHash: refreshTokenHash(refreshToken), familyId: current.familyId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    } });
    return { token, refreshToken };
  });
  if (!result) throw new RefreshSessionError();
  return result;
}

export async function revokeRefreshSessionFamily(userId: string, presentedToken: string): Promise<void> {
  await withTenant(userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:refresh-sessions`}, 0))`;
    const current = await tx.refreshTokenSession.findFirst({ where: { userId, tokenHash: refreshTokenHash(presentedToken) } });
    if (!current) return;
    await tx.refreshTokenSession.updateMany({ where: { userId, familyId: current.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { userId, action: 'AUTH_LOGOUT', resource: 'refresh_token_session', resourceId: current.id, details: { familyRevoked: true } } });
  });
}
