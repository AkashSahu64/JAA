import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { parseProviderResponse, verifySubmission } from './submission-verification';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('independent submission verification persistence', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const leverJobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const leverApplicationId = randomUUID();
  const attemptId = randomUUID();
  const leverAttemptId = randomUUID();
  const startedAt = new Date('2026-09-14T00:00:00.000Z');
  const observedAt = new Date('2026-09-14T00:01:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Verifier Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
    await prisma.job.create({ data: { id: leverJobId, source: 'LEVER', sourceJobId: randomUUID(), company: 'Lever Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://example.lever.co/example/jobs/1', sourceUrl: 'https://example.lever.co/example/jobs/1' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume' } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'UNCONFIRMED', appliedAt: startedAt } });
    await prisma.application.create({ data: { id: leverApplicationId, userId, jobId: leverJobId, resumeVersionId: versionId, status: 'UNCONFIRMED', appliedAt: startedAt } });
    await prisma.applicationAttempt.create({ data: { id: attemptId, applicationId, attemptNumber: 1, status: 'UNCONFIRMED', startedAt, completedAt: observedAt, logs: [] } });
    await prisma.applicationAttempt.create({ data: { id: leverAttemptId, applicationId: leverApplicationId, attemptNumber: 1, status: 'UNCONFIRMED', startedAt, completedAt: observedAt, logs: [] } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    // Jobs are not user-owned, so removing the candidate does not remove these fixtures.
    await prisma.job.deleteMany({ where: { id: { in: [jobId, leverJobId] } } });
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

  it('persists trusted Lever confirmation, binds the matched attempt, and replays exactly', async () => {
    const evidence = parseProviderResponse({
      applicationId: leverApplicationId, provider: 'LEVER', response: { status: 'accepted', confirmationId: 'lv-confirmed-1' }, observedAt,
    });
    const input = { userId, applicationId: leverApplicationId, correlationId: 'verification-fixture-lever', trustedBoundary: true as const, evidence };
    const first = await verifySubmission(input);
    expect(first.replayed).toBe(false);
    expect(first.evidence).toMatchObject({ attemptId: leverAttemptId, confirmationId: 'lv-confirmed-1' });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: leverApplicationId } }))
      .resolves.toMatchObject({ status: 'CONFIRMED', confirmationId: 'lv-confirmed-1' });
    await expect(prisma.submissionVerificationEvidence.findUniqueOrThrow({ where: { applicationId_evidenceHash: { applicationId: leverApplicationId, evidenceHash: evidence.evidenceHash } } }))
      .resolves.toMatchObject({ userId, applicationId: leverApplicationId, attemptId: leverAttemptId, provider: 'LEVER' });
    await expect(prisma.applicationAttempt.findUniqueOrThrow({ where: { id: leverAttemptId } }))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(verifySubmission(input)).resolves.toMatchObject({ replayed: true });
  });
});
