import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import { generateRefreshToken } from '@jobagent/security';
import { refreshTokenHash, revokeRefreshSessionFamily, rotateRefreshSession } from './refresh-sessions';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable refresh rotation and reuse', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const owner = { userId, email: `${userId}@example.invalid` };
  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', 'disposable-refresh-integration-secret');
    await prisma.user.createMany({ data: [userId, otherUserId].map(id => ({ id, email: `${id}@example.invalid`, name: 'Refresh fixture', passwordHash: 'unused' })) });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  async function seed() {
    const token = generateRefreshToken(owner);
    const familyId = randomUUID();
    await prisma.refreshTokenSession.create({ data: { userId, familyId, tokenHash: refreshTokenHash(token), expiresAt: new Date(Date.now() + 60_000) } });
    return { token, familyId };
  }
  const active = (familyId: string) => prisma.refreshTokenSession.count({ where: { userId, familyId, revokedAt: null } });

  it('persists family revocation and audit after reuse returns an error', async () => {
    const { token, familyId } = await seed();
    const next = await rotateRefreshSession(token);
    await expect(active(familyId)).resolves.toBe(1);
    await expect(rotateRefreshSession(token)).rejects.toMatchObject({ name: 'RefreshSessionError' });
    await expect(active(familyId)).resolves.toBe(0);
    await expect(rotateRefreshSession(next.refreshToken)).rejects.toMatchObject({ name: 'RefreshSessionError' });
    expect(await prisma.auditLog.count({ where: { userId, action: 'AUTH_REFRESH_REUSE_DETECTED' } })).toBeGreaterThan(0);
  });

  it('allows one concurrent rotation and revokes its successor when reuse is detected', async () => {
    const { token, familyId } = await seed();
    const results = await Promise.allSettled([rotateRefreshSession(token), rotateRefreshSession(token)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(active(familyId)).resolves.toBe(0);
  });

  it('fences reuse of an ancestor against rotation of its descendant', async () => {
    const { token, familyId } = await seed();
    const next = await rotateRefreshSession(token);
    await Promise.allSettled([rotateRefreshSession(next.refreshToken), rotateRefreshSession(token)]);
    await expect(active(familyId)).resolves.toBe(0);
  });

  it('isolates owners and prevents a racing rotation from escaping logout', async () => {
    const { token, familyId } = await seed();
    await revokeRefreshSessionFamily(otherUserId, token);
    await expect(active(familyId)).resolves.toBe(1);
    await Promise.allSettled([rotateRefreshSession(token), revokeRefreshSessionFamily(userId, token)]);
    await expect(active(familyId)).resolves.toBe(0);
  });
});
