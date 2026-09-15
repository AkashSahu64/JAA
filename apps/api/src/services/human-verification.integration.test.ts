import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import {
  HumanVerificationError,
  requestHumanVerification,
  resolveHumanVerification,
  resumeHumanVerification,
} from './human-verification';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('human verification transaction', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const jobId = randomUUID();
  const submissionJobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const applicationId = randomUUID();
  const submissionApplicationId = randomUUID();

  const request = (overrides: Partial<Parameters<typeof requestHumanVerification>[0]> = {}) => requestHumanVerification({
    userId,
    applicationId,
    type: 'CAPTCHA',
    prompt: 'Complete the verification in the browser, then acknowledge it here.',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Verification Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Verification Fixture' },
    ] });
    await prisma.job.create({ data: {
      id: jobId, source: 'fixture', company: 'Example', title: 'Engineer', description: 'fixture',
      applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job',
    } });
    await prisma.job.create({ data: {
      id: submissionJobId, source: 'fixture', company: 'Example', title: 'Submission Engineer', description: 'fixture',
      applicationUrl: 'https://example.invalid/apply-submission', sourceUrl: 'https://example.invalid/job-submission',
    } });
    await prisma.resume.create({ data: { id: resumeId, userId, name: 'Fixture resume', content: 'Approved fixture facts only.' } });
    await prisma.resumeVersion.create({ data: { id: resumeVersionId, resumeId, content: 'Approved fixture facts only.' } });
    await prisma.application.create({ data: {
      id: applicationId, userId, jobId, resumeVersionId, status: 'APPLICATION_STARTED',
    } });
    await prisma.application.create({ data: {
      id: submissionApplicationId, userId, jobId: submissionJobId, resumeVersionId, status: 'SUBMISSION_PENDING',
    } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.job.deleteMany({ where: { id: { in: [jobId, submissionJobId] } } });
    await prisma.$disconnect();
  });

  it('pauses, idempotently acknowledges, and safely resumes without storing credential material', async () => {
    const input = {
      userId, applicationId, type: 'CAPTCHA', prompt: 'Complete the verification in the browser, then acknowledge it here.',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), correlationId: randomUUID(), idempotencyKey: randomUUID(),
    };
    const created = await requestHumanVerification(input);
    const replay = await requestHumanVerification(input);
    expect(created.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, verification: { id: created.verification.id } });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } }))
      .resolves.toMatchObject({ status: 'WAITING_FOR_USER', version: 2 });

    const resolved = await resolveHumanVerification({ userId, verificationId: created.verification.id, correlationId: input.correlationId });
    expect(resolved).toMatchObject({ replayed: false, verification: { status: 'RESOLVED', resolution: { credentialMaterialStored: false } } });
    await expect(resolveHumanVerification({ userId, verificationId: created.verification.id, correlationId: input.correlationId }))
      .resolves.toMatchObject({ replayed: true, resumeJob: { id: resolved.resumeJob.id } });
    await expect(resumeHumanVerification(userId, created.verification.id, input.correlationId))
      .resolves.toEqual({ resumed: true });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } }))
      .resolves.toMatchObject({ status: 'FORM_FILLED', version: 3 });
    await expect(prisma.automationJob.count({ where: { applicationId, type: 'RESUME_APPLICATION_AFTER_VERIFICATION' } }))
      .resolves.toBe(1);
  });

  it('rejects tenant-crossing access', async () => {
    const created = await request({
      applicationId,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await prisma.humanVerification.update({
      where: { id: created.verification.id },
      data: { status: 'EXPIRED', resolvedAt: new Date(), resolution: { testCleanup: true, credentialMaterialStored: false } },
    });
    await expect(resolveHumanVerification({ userId: otherUserId, verificationId: created.verification.id, correlationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<HumanVerificationError>);
    await prisma.humanVerification.update({
      where: { id: created.verification.id },
      data: { status: 'EXPIRED', resolvedAt: new Date(), resolution: { testCleanup: true, credentialMaterialStored: false } },
    });
  });

  it('pauses a submission checkpoint and resumes to explicit re-authorization readiness', async () => {
    const created = await request({ applicationId: submissionApplicationId, idempotencyKey: randomUUID(), correlationId: randomUUID() });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: submissionApplicationId } }))
      .resolves.toMatchObject({ status: 'WAITING_FOR_USER', version: 2 });
    await resolveHumanVerification({ userId, verificationId: created.verification.id, correlationId: created.verification.correlationId });
    await resumeHumanVerification(userId, created.verification.id, created.verification.correlationId);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: submissionApplicationId } }))
      .resolves.toMatchObject({ status: 'READY_TO_SUBMIT', version: 3 });
  });

  it('expires an acknowledgement whose expiry passes before resolution', async () => {
    const created = await request({
      applicationId,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      expiresAt: new Date(Date.now() + 1_500),
    });
    await new Promise(resolve => setTimeout(resolve, 1_600));
    await expect(resolveHumanVerification({ userId, verificationId: created.verification.id, correlationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'EXPIRED' } satisfies Partial<HumanVerificationError>);
  });
});
