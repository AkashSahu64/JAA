import { createHash } from 'node:crypto';
import { withTenant } from '@jobagent/database';
import { generateRefreshToken, generateToken, verifyRefreshToken } from '@jobagent/security';

export class RefreshSessionError extends Error {
  constructor() { super('Invalid or expired refresh token'); this.name = 'RefreshSessionError'; }
}

export function refreshTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validSessionIdentity(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
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
      // Rotation must not extend the lifetime of the original session family.
      // Otherwise a stolen refresh token can keep a family alive indefinitely
      // by rotating it just before each rolling seven-day window expires.
      expiresAt: current.expiresAt,
    } });
    return { token, refreshToken };
  });
  if (!result) throw new RefreshSessionError();
  return result;
}

export async function revokeRefreshSessionFamily(userId: string, presentedToken: string): Promise<void> {
  if (!validSessionIdentity(userId) || typeof presentedToken !== 'string' || !presentedToken.trim() || presentedToken.length > 4096
    || Array.from(presentedToken).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new RefreshSessionError();
  }
  await withTenant(userId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:refresh-sessions`}, 0))`;
    const current = await tx.refreshTokenSession.findFirst({ where: { userId, tokenHash: refreshTokenHash(presentedToken) } });
    if (!current) return;
    await tx.refreshTokenSession.updateMany({ where: { userId, familyId: current.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { userId, action: 'AUTH_LOGOUT', resource: 'refresh_token_session', resourceId: current.id, details: { familyRevoked: true } } });
  });
}
