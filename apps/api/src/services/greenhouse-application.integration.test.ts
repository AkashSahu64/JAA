import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import type { GreenhouseFormPort } from '@jobagent/job-engine';
import { GreenhouseApplicationService } from './greenhouse-application';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function form(snapshot: Awaited<ReturnType<GreenhouseFormPort['snapshot']>>): GreenhouseFormPort {
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

describeDatabase.sequential('Greenhouse application persistence', () => {
  const userId = randomUUID();
  const safeJobId = randomUUID();
  const verificationJobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const safeApplicationId = randomUUID();
  const verificationApplicationId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Ada Lovelace' } });
    await prisma.userProfile.create({ data: {
      userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid', phone: '+15550100', locationCity: 'London', linkedIn: 'https://www.linkedin.com/in/ada',
    } });
    await prisma.job.createMany({ data: [
      { id: safeJobId, source: 'GREENHOUSE', company: 'Example', title: 'Engineer', description: 'fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' },
      { id: verificationJobId, source: 'GREENHOUSE', company: 'Example', title: 'Analyst', description: 'fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/2', sourceUrl: 'https://boards.greenhouse.io/example/jobs/2' },
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

  it('durably records only profile-key provenance and transitions a validated safe form', async () => {
    const browser = browserSessions();
    const service = new GreenhouseApplicationService(browser as never, () => form({
      step: 1, hasNextStep: false,
      fields: [
        { id: 'first_name', name: 'first_name', label: 'First name', kind: 'TEXT', required: true },
        { id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true },
      ],
    }));
    await expect(service.execute({ userId, applicationId: safeApplicationId, workerId: 'worker', correlationId: 'safe', idempotencyKey: 'safe' }))
      .resolves.toEqual({ outcome: 'FORM_FILLED' });

    await expect(prisma.application.findUniqueOrThrow({ where: { id: safeApplicationId } }))
      .resolves.toMatchObject({ status: 'FORM_FILLED', version: 2 });
    const answers = await prisma.applicationAnswer.findMany({ where: { applicationId: safeApplicationId }, orderBy: { question: { normalizedKey: 'asc' } } });
    expect(answers).toHaveLength(2);
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: { profileKey: 'firstName' }, provenance: expect.objectContaining({ source: 'USER_PROFILE', profileKey: 'firstName' }) }),
      expect.objectContaining({ value: { profileKey: 'email' }, provenance: expect.objectContaining({ source: 'USER_PROFILE', profileKey: 'email' }) }),
    ]));
    expect(JSON.stringify(answers)).not.toContain('ada@example.invalid');
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('pauses for CAPTCHA without entering an answer or credential material', async () => {
    const browser = browserSessions();
    const service = new GreenhouseApplicationService(browser as never, () => form({
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
    // The durable key is provider/step/semantic, not the mutable DOM id.
    await expect(prisma.applicationQuestion.findFirstOrThrow({ where: { applicationId: verificationApplicationId } }))
      .resolves.toMatchObject({ risk: 'HUMAN_VERIFICATION_REQUIRED' });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
