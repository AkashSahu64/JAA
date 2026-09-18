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

/**
 * A port whose snapshot advances only when the shared loop advances the step, so a
 * multi-step Lever form is exercised through the same reinspection path a real page uses.
 */
function stagedForm(steps: ReadonlyArray<Awaited<ReturnType<LeverFormPort['snapshot']>>>) {
  let index = 0;
  const port = {
    snapshot: vi.fn(async () => steps[index]!),
    fill: vi.fn(async (_fieldId: string, _value: string) => undefined),
    select: vi.fn(async (_fieldId: string, _value: string | readonly string[]) => undefined),
    setChecked: vi.fn(async (_fieldId: string, _checked: boolean) => undefined),
    validate: vi.fn(async () => [] as readonly { fieldId?: string; message: string }[]),
    advance: vi.fn(async () => { index = Math.min(index + 1, steps.length - 1); }),
    uploadDocument: vi.fn(async (_fieldId: string, _document: {
      fileName: string; mimeType: string; checksumSha256: string; bytes: Uint8Array;
    }) => undefined),
  };
  return port as unknown as LeverFormPort & typeof port;
}

const LEVER_RESUME_CHECKSUM = 'e'.repeat(64);

describeDatabase.sequential('Lever application persistence', () => {
  const userId = randomUUID();
  const safeJobId = randomUUID();
  const verificationJobId = randomUUID();
  const chainJobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const safeApplicationId = randomUUID();
  const verificationApplicationId = randomUUID();
  const chainApplicationId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Ada Lovelace' } });
    await prisma.userProfile.create({ data: { userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid', phone: '+15550100' } });
    await prisma.job.createMany({ data: [
      { id: safeJobId, source: 'LEVER', company: 'Example', title: 'Engineer', description: 'fixture', applicationUrl: 'https://jobs.lever.co/example/1/apply', sourceUrl: 'https://jobs.lever.co/example/1' },
      { id: verificationJobId, source: 'LEVER', company: 'Example', title: 'Analyst', description: 'fixture', applicationUrl: 'https://jobs.lever.co/example/2/apply', sourceUrl: 'https://jobs.lever.co/example/2' },
      { id: chainJobId, source: 'LEVER', company: 'Example', title: 'Chain', description: 'fixture', applicationUrl: 'https://jobs.lever.co/example/3/apply', sourceUrl: 'https://jobs.lever.co/example/3' },
    ] });
    await prisma.resume.create({ data: { id: resumeId, userId, name: 'Fixture', content: 'Approved facts' } });
    await prisma.resumeVersion.create({ data: { id: resumeVersionId, resumeId, content: 'Approved facts' } });
    await prisma.application.createMany({ data: [
      { id: safeApplicationId, userId, jobId: safeJobId, resumeVersionId, status: 'APPLICATION_STARTED' },
      { id: verificationApplicationId, userId, jobId: verificationJobId, resumeVersionId, status: 'APPLICATION_STARTED' },
      { id: chainApplicationId, userId, jobId: chainJobId, resumeVersionId, status: 'APPLICATION_STARTED' },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    // Jobs are not user-owned, so the cascade above does not remove this fixture.
    await prisma.job.deleteMany({ where: { id: { in: [safeJobId, verificationJobId, chainJobId] } } });
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

  it('drives the Lever chain through document upload, multi-step advance, and durable evidence', async () => {
    await prisma.objectMetadata.create({ data: {
      userId, resumeId, resumeVersionId, kind: 'RESUME_APPROVED', bucket: 'private',
      objectKey: `private/resume_approved/${userId}/${LEVER_RESUME_CHECKSUM}`, fileName: 'lever-resume.pdf', mimeType: 'application/pdf',
      byteSize: BigInt(24), checksumSha256: LEVER_RESUME_CHECKSUM, encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN',
      approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId,
    } });
    const customQuestion = await prisma.applicationQuestion.create({ data: {
      userId, applicationId: chainApplicationId,
      externalKey: 'LEVER:step_1:TEXT:custom_question:question:one',
      label: 'Question', normalizedKey: 'custom_question', fieldType: 'TEXT', required: true, risk: 'AMBIGUOUS',
    } });
    const approved = await prisma.applicationAnswer.create({ data: {
      userId, applicationId: chainApplicationId, questionId: customQuestion.id,
      value: 'A reviewed and explicitly approved answer', source: 'USER_INPUT',
      provenance: { source: 'USER_INPUT', approvedBy: userId },
      createdAt: new Date(Date.now() - 60_000),
      approved: true, approvedAt: new Date(), approvedBy: userId, version: 1,
    } });

    const browser = browserSessions();
    const port = stagedForm([
      { step: 1, stepIdentity: 'step-1', hasNextStep: true, fields: [
        { id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true },
        { id: 'resume_file', name: 'resume', label: 'Resume', kind: 'FILE', required: true },
        { id: 'custom_question', name: 'custom_question', label: 'Question', kind: 'TEXT', required: true },
      ] },
      { step: 2, stepIdentity: 'step-2', hasNextStep: false, fields: [
        { id: 'g-recaptcha-response', name: 'g-recaptcha-response', label: 'Security check', kind: 'TEXT', required: true },
      ] },
    ]);
    const storage = {
      readAuthorized: vi.fn(async (_userId: string, stored: { fileName: string; mimeType: string }) => ({
        buffer: Buffer.from('%PDF-1.4 lever approved bytes'),
        fileName: stored.fileName,
        mimeType: stored.mimeType,
      })),
    };
    const service = new LeverApplicationService(browser as never, () => port, storage as never);
    await expect(service.execute({ userId, applicationId: chainApplicationId, workerId: 'worker', correlationId: 'lever-chain', idempotencyKey: 'lever-chain' }))
      .resolves.toEqual({ outcome: 'HUMAN_VERIFICATION_REQUIRED' });

    // The Lever port was selected and its own upload transport received the exact
    // approved object; the checksum is the stored one, never anything the page supplied.
    expect(storage.readAuthorized).toHaveBeenCalledWith(userId, expect.objectContaining({ checksumSha256: LEVER_RESUME_CHECKSUM, resumeVersionId }));
    expect(port.uploadDocument).toHaveBeenCalledOnce();
    expect(port.uploadDocument.mock.calls[0]![0]).toBe('resume_file');
    expect(port.uploadDocument.mock.calls[0]![1]).toMatchObject({ fileName: 'lever-resume.pdf', checksumSha256: LEVER_RESUME_CHECKSUM });

    // The shared deferred-advance rule applies to Lever identically: the step whose only
    // blocker was the resume upload still advanced exactly once.
    expect(port.advance).toHaveBeenCalledOnce();
    expect(port.fill.mock.calls.map(call => call[0]).sort()).toEqual(['custom_question', 'email']);

    // Provider-specific evidence naming and identity, with the same durable shape.
    const audits = await prisma.auditLog.findMany({ where: { userId, resourceId: chainApplicationId, action: 'LEVER_FORM_STEP_ASSESSED' } });
    expect(audits.map(audit => (audit.details as { step: number }).step).sort((left, right) => left - right)).toEqual([1, 2]);
    await expect(prisma.applicationQuestion.findMany({
      where: { applicationId: chainApplicationId }, orderBy: { externalKey: 'asc' },
      select: { externalKey: true, risk: true },
    })).resolves.toEqual([
      { externalKey: 'LEVER:step_1:FILE:resume:resume:one', risk: 'UNSUPPORTED' },
      { externalKey: 'LEVER:step_1:TEXT:custom_question:question:one', risk: 'AMBIGUOUS' },
      { externalKey: 'LEVER:step_1:TEXT:email:email:one', risk: 'PROFILE_DERIVED' },
      { externalKey: 'LEVER:step_2:TEXT:g_recaptcha_response:security_check:one', risk: 'HUMAN_VERIFICATION_REQUIRED' },
    ]);
    await expect(prisma.humanVerification.findFirstOrThrow({ where: { applicationId: chainApplicationId } }))
      .resolves.toMatchObject({ type: 'CAPTCHA', status: 'PENDING' });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: chainApplicationId } }))
      .resolves.toMatchObject({ status: 'WAITING_FOR_USER' });
    // The approved answer is durable provenance; the resume upload is never an answer row.
    const answers = await prisma.applicationAnswer.findMany({ where: { applicationId: chainApplicationId } });
    expect(answers.map(answer => answer.id)).toContain(approved.id);
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approved.id, source: 'USER_INPUT', approved: true }),
      expect.objectContaining({ source: 'USER_PROFILE', approved: true }),
    ]));
    expect(storage.readAuthorized).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
