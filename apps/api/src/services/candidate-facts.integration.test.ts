import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateToken } from '@jobagent/security';
import { createApp } from '../app';
import { prisma } from '@jobagent/database';
import {
  decideResumeCandidateFact,
  listResumeCandidateFacts,
  replaceResumeCandidateFacts,
  requireApprovedCandidateClaims,
} from './candidate-facts';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('candidate fact approval boundary', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const resumeId = randomUUID();
  const email = `${userId}@example.invalid`;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'candidate-fact-integration-secret-at-least-32-characters';
    await prisma.user.createMany({ data: [
      { id: userId, email, passwordHash: 'fixture', name: 'Candidate Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Candidate Fixture' },
    ] });
    await prisma.resume.create({
      data: {
        id: resumeId,
        userId,
        name: 'Synthetic Master Resume',
        isMaster: true,
        content: 'SUMMARY\nReliable platform engineer.\n\nSKILLS\nTypeScript, PostgreSQL',
      },
    });
    server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('stores exact cited parser output as unapproved', async () => {
    const facts = await replaceResumeCandidateFacts(resumeId, userId);
    expect(facts.length).toBeGreaterThan(1);
    expect(facts.every((fact) => !fact.approved && fact.approvedAt === null && fact.approvedBy === null)).toBe(true);
    const stored = await listResumeCandidateFacts(resumeId, userId);
    const source = 'SUMMARY\nReliable platform engineer.\n\nSKILLS\nTypeScript, PostgreSQL';
    expect(stored.every((fact) => source.slice(fact.sourceStart!, fact.sourceEnd!) === fact.sourceText)).toBe(true);
  });

  it('denies unsupported and pending claims until the user approves the cited fact', async () => {
    await expect(requireApprovedCandidateClaims(userId, ['TypeScript']))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const fact = await prisma.resumeSourceFact.findFirstOrThrow({ where: { resumeId, factType: 'SKILL', sourceText: 'TypeScript' } });
    const approved = await decideResumeCandidateFact({ resumeId, factId: fact.id, userId, decision: 'APPROVE' });
    expect(approved).toMatchObject({ approved: true, approvedBy: userId, approvedAt: expect.any(Date) });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { userId, resourceId: fact.id, action: 'CANDIDATE_FACT_APPROVED' } }))
      .resolves.toMatchObject({ details: expect.objectContaining({ resumeId, checksum: fact.checksum }) });
    await expect(requireApprovedCandidateClaims(userId, [' typescript '])).resolves.toEqual([
      expect.objectContaining({ id: fact.id, sourceText: 'TypeScript' }),
    ]);
    await expect(requireApprovedCandidateClaims(userId, ['Kubernetes']))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('exposes tenant-scoped citations and decisions through the authenticated API', async () => {
    const pending = await prisma.resumeSourceFact.findFirstOrThrow({ where: { resumeId, approved: false } });
    const token = generateToken({ userId, email });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const list = await fetch(`${baseUrl}/api/resumes/${resumeId}/facts`, { headers });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([expect.objectContaining({ id: pending.id, sourceText: pending.sourceText, approved: false })]),
    });

    const decision = await fetch(`${baseUrl}/api/resumes/${resumeId}/facts/${pending.id}/decision`, {
      method: 'POST', headers, body: JSON.stringify({ decision: 'APPROVE' }),
    });
    expect(decision.status).toBe(200);
    await expect(decision.json()).resolves.toMatchObject({ success: true, data: { id: pending.id, approved: true } });

    const otherToken = generateToken({ userId: otherUserId, email: `${otherUserId}@example.invalid` });
    const crossTenant = await fetch(`${baseUrl}/api/resumes/${resumeId}/facts`, { headers: { Authorization: `Bearer ${otherToken}` } });
    expect(crossTenant.status).toBe(404);
  });

  it('rejects pending facts and enforces tenant ownership', async () => {
    const pending = await prisma.resumeSourceFact.findFirstOrThrow({ where: { resumeId, approved: false } });
    await expect(decideResumeCandidateFact({ resumeId, factId: pending.id, userId: otherUserId, decision: 'APPROVE' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(decideResumeCandidateFact({ resumeId, factId: pending.id, userId, decision: 'REJECT' })).resolves.toBeNull();
    await expect(prisma.resumeSourceFact.findUnique({ where: { id: pending.id } })).resolves.toBeNull();
    await expect(prisma.auditLog.findFirstOrThrow({ where: { userId, resourceId: pending.id, action: 'CANDIDATE_FACT_REJECTED' } }))
      .resolves.toMatchObject({ details: expect.objectContaining({ resumeId, checksum: pending.checksum }) });
  });
});
