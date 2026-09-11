import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import type { LeverFormPort } from '@jobagent/job-engine';
import { LeverApplicationService } from './lever-application';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function form(snapshot: Awaited<ReturnType<LeverFormPort['snapshot']>>): LeverFormPort {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  };
}

function browserSessions() {
  return {
    start: vi.fn(async () => ({ session: { externalRef: randomUUID() }, replayed: false })),
    withPage: vi.fn(async (_userId, _reference, operation) => operation({})),
    close: vi.fn(async () => undefined),
  };
}

describeDatabase.sequential('Lever application persistence', () => {
  const userId = randomUUID();
  const safeJobId = randomUUID();
  const verificationJobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const safeApplicationId = randomUUID();
  const verificationApplicationId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Ada Lovelace' } });
    await prisma.userProfile.create({ data: { userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid', phone: '+15550100' } });
    await prisma.job.createMany({ data: [
      { id: safeJobId, source: 'LEVER', company: 'Example', title: 'Engineer', description: 'fixture', applicationUrl: 'https://jobs.lever.co/example/1/apply', sourceUrl: 'https://jobs.lever.co/example/1' },
      { id: verificationJobId, source: 'LEVER', company: 'Example', title: 'Analyst', description: 'fixture', applicationUrl: 'https://jobs.lever.co/example/2/apply', sourceUrl: 'https://jobs.lever.co/example/2' },
    ] });
    await prisma.resume.create({ data: { id: resumeId, userId, name: 'Fixture', content: 'Approved facts' } });
    await prisma.resumeVersion.create({ data: { id: resumeVersionId, resumeId, content: 'Approved facts' } });
    await prisma.application.createMany({ data: [
      { id: safeApplicationId, userId, jobId: safeJobId, resumeVersionId, status: 'APPLICATION_STARTED' },
      { id: verificationApplicationId, userId, jobId: verificationJobId, resumeVersionId, status: 'APPLICATION_STARTED' },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.job.deleteMany({ where: { id: { in: [safeJobId, verificationJobId] } } });
    await prisma.$disconnect();
  });

  it('persists approved profile-key evidence without storing raw values', async () => {
    const browser = browserSessions();
    const service = new LeverApplicationService(browser as never, () => form({
      step: 1, hasNextStep: false,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    }));

    await expect(service.execute({ userId, applicationId: safeApplicationId, workerId: 'worker', correlationId: 'safe', idempotencyKey: 'safe' }))
      .resolves.toEqual({ outcome: 'FORM_FILLED' });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: safeApplicationId } }))
      .resolves.toMatchObject({ status: 'FORM_FILLED', version: 2 });
    const answer = await prisma.applicationAnswer.findFirstOrThrow({ where: { applicationId: safeApplicationId } });
    expect(answer).toMatchObject({ value: { profileKey: 'email' }, provenance: expect.objectContaining({ source: 'USER_PROFILE', profileKey: 'email' }) });
    expect(JSON.stringify(answer)).not.toContain('ada@example.invalid');
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('pauses for CAPTCHA without submitting or storing an answer', async () => {
    const browser = browserSessions();
    const service = new LeverApplicationService(browser as never, () => form({
      step: 1, hasNextStep: false,
      fields: [{ id: 'captcha', name: 'g-recaptcha-response', label: 'Security check', kind: 'TEXT', required: true }],
    }));

    await expect(service.execute({ userId, applicationId: verificationApplicationId, workerId: 'worker', correlationId: 'captcha', idempotencyKey: 'captcha' }))
      .resolves.toEqual({ outcome: 'HUMAN_VERIFICATION_REQUIRED' });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: verificationApplicationId } }))
      .resolves.toMatchObject({ status: 'WAITING_FOR_USER', version: 2 });
    await expect(prisma.applicationAnswer.count({ where: { applicationId: verificationApplicationId } })).resolves.toBe(0);
    await expect(prisma.humanVerification.findFirstOrThrow({ where: { applicationId: verificationApplicationId } }))
      .resolves.toMatchObject({ type: 'CAPTCHA', status: 'PENDING', resolution: null });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
