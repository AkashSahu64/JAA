import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { parseProviderResponse, verifySubmission } from './submission-verification';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('independent submission verification persistence', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const attemptId = randomUUID();
  const startedAt = new Date('2026-09-14T00:00:00.000Z');
  const observedAt = new Date('2026-09-14T00:01:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Verifier Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume' } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'UNCONFIRMED', appliedAt: startedAt } });
    await prisma.applicationAttempt.create({ data: { id: attemptId, applicationId, attemptNumber: 1, status: 'UNCONFIRMED', startedAt, completedAt: observedAt, logs: [] } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('persists trusted confirmation, binds the matched attempt, and replays exactly', async () => {
    const evidence = parseProviderResponse({
      applicationId, provider: 'GREENHOUSE', response: { status: 'accepted', confirmationId: 'gh-confirmed-1' }, observedAt,
    });
    const input = { userId, applicationId, correlationId: 'verification-fixture', trustedBoundary: true as const, evidence };
    const first = await verifySubmission(input);
    expect(first.replayed).toBe(false);
    expect(first.evidence).toMatchObject({ attemptId, confirmationId: 'gh-confirmed-1' });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } }))
      .resolves.toMatchObject({ status: 'CONFIRMED', confirmationId: 'gh-confirmed-1' });
    await expect(prisma.submissionVerificationEvidence.findUniqueOrThrow({ where: { applicationId_evidenceHash: { applicationId, evidenceHash: evidence.evidenceHash } } }))
      .resolves.toMatchObject({ userId, applicationId, attemptId, provider: 'GREENHOUSE' });
    await expect(prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(verifySubmission(input)).resolves.toMatchObject({ replayed: true });
  });
});
