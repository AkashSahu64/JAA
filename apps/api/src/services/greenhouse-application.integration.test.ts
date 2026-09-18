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

/**
 * A port whose snapshot changes only when the shared loop advances the step, so a
 * multi-step form is exercised through the same reinspection path a provider page uses.
 */
function stagedForm(steps: ReadonlyArray<Awaited<ReturnType<GreenhouseFormPort['snapshot']>>>) {
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
  return port as unknown as GreenhouseFormPort & typeof port;
}

const RESUME_CHECKSUM = 'd'.repeat(64);

/**
 * Binary access is a separate system with its own suite; this boundary double keeps
 * the chain test focused on composition while still proving which exact object the
 * chain asked for.
 */
function documentStorage() {
  return {
    readAuthorized: vi.fn(async (_userId: string, stored: { fileName: string; mimeType: string }) => ({
      buffer: Buffer.from('%PDF-1.4 approved bytes'),
      fileName: stored.fileName,
      mimeType: stored.mimeType,
    })),
  };
}

describeDatabase.sequential('Greenhouse application persistence', () => {
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
    await prisma.userProfile.create({ data: {
      userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid', phone: '+15550100', locationCity: 'London', linkedIn: 'https://www.linkedin.com/in/ada',
    } });
    await prisma.job.createMany({ data: [
      { id: safeJobId, source: 'GREENHOUSE', company: 'Example', title: 'Engineer', description: 'fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' },
      { id: verificationJobId, source: 'GREENHOUSE', company: 'Example', title: 'Analyst', description: 'fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/2', sourceUrl: 'https://boards.greenhouse.io/example/jobs/2' },
      { id: chainJobId, source: 'GREENHOUSE', company: 'Example', title: 'Chain', description: 'fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/3', sourceUrl: 'https://boards.greenhouse.io/example/jobs/3' },
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

  it('drives the whole chain in order from field detection through durable evidence', async () => {
    // An approved, owner-bound document and answer are seeded first: the chain must
    // consume them, not the other way round.
    await prisma.objectMetadata.create({ data: {
      userId, resumeId, resumeVersionId, kind: 'RESUME_APPROVED', bucket: 'private',
      objectKey: `private/resume_approved/${userId}/${RESUME_CHECKSUM}`, fileName: 'resume.pdf', mimeType: 'application/pdf',
      byteSize: BigInt(24), checksumSha256: RESUME_CHECKSUM, encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN',
      approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId,
    } });
    const customQuestion = await prisma.applicationQuestion.create({ data: {
      userId, applicationId: chainApplicationId,
      externalKey: 'GREENHOUSE:step_1:TEXT:custom_question:question:one',
      label: 'Question', normalizedKey: 'custom_question', fieldType: 'TEXT', required: true, risk: 'AMBIGUOUS',
    } });
    const customQuestionAnswer = await prisma.applicationAnswer.create({ data: {
      userId, applicationId: chainApplicationId, questionId: customQuestion.id,
      value: 'A reviewed and explicitly approved answer', source: 'USER_INPUT',
      provenance: { source: 'USER_INPUT', approvedBy: userId },
      // `application_answers_approval_consistency` requires approvedAt >= createdAt,
      // so the draft predates the approval exactly as a real review would.
      createdAt: new Date(Date.now() - 60_000),
      approved: true, approvedAt: new Date(), approvedBy: userId, version: 1,
    } });

    const browser = browserSessions();
    const port = stagedForm([
      { step: 1, stepIdentity: 'step-1', hasNextStep: true, fields: [
        { id: 'first_name', name: 'first_name', label: 'First name', kind: 'TEXT', required: true },
        { id: 'resume_file', name: 'resume', label: 'Resume', kind: 'FILE', required: true },
        { id: 'custom_question', name: 'custom_question', label: 'Question', kind: 'TEXT', required: true },
      ] },
      { step: 2, stepIdentity: 'step-2', hasNextStep: false, fields: [
        { id: 'g-recaptcha-response', name: 'g-recaptcha-response', label: 'Security check', kind: 'TEXT', required: true },
      ] },
    ]);
    const storage = documentStorage();
    const service = new GreenhouseApplicationService(browser as never, () => port, storage as never);
    await expect(service.execute({ userId, applicationId: chainApplicationId, workerId: 'worker', correlationId: 'chain', idempotencyKey: 'chain' }))
      .resolves.toEqual({ outcome: 'HUMAN_VERIFICATION_REQUIRED' });

    // FIELD DETECTION + FIELD MAPPING: each control reached its policy class, and the
    // identity is the provider/step/semantic key rather than the mutable DOM id. Every
    // identity part is normalized (`step-1` -> `step_1`, `Security check` ->
    // `security_check`), which is why the seeded answer is keyed on the normalized form.
    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId: chainApplicationId }, orderBy: { externalKey: 'asc' },
    });
    expect(questions.map(question => [question.externalKey, question.risk])).toEqual([
      ['GREENHOUSE:step_1:FILE:resume:resume:one', 'UNSUPPORTED'],
      ['GREENHOUSE:step_1:TEXT:custom_question:question:one', 'AMBIGUOUS'],
      ['GREENHOUSE:step_1:TEXT:first_name:first_name:one', 'PROFILE_DERIVED'],
      ['GREENHOUSE:step_2:TEXT:g_recaptcha_response:security_check:one', 'HUMAN_VERIFICATION_REQUIRED'],
    ]);
    // Required/optional state is represented durably, per step rather than per page.
    expect(questions.every(question => question.required)).toBe(true);
    expect([...new Set(questions.map(question => (question.source as Record<string, unknown>).step))].sort((left, right) => Number(left) - Number(right)))
      .toEqual([1, 2]);

    // APPROVED ANSWERS: the profile-mapped field and the explicitly approved answer were
    // both filled, and no draft or AI path supplied a value.
    expect(port.fill.mock.calls.map(call => call[0]).sort()).toEqual(['custom_question', 'first_name']);
    expect(port.fill.mock.calls.find(call => call[0] === 'custom_question')?.[1]).toBe('A reviewed and explicitly approved answer');

    // EXACT DOCUMENT SELECTION + VALIDATION + UPLOAD: the chain read the one approved
    // object bound to this application's resume version and uploaded it exactly once,
    // carrying the stored checksum rather than anything the page supplied.
    expect(storage.readAuthorized).toHaveBeenCalledWith(userId, expect.objectContaining({ checksumSha256: RESUME_CHECKSUM, resumeVersionId }));
    expect(port.uploadDocument).toHaveBeenCalledTimes(1);
    expect(port.uploadDocument.mock.calls[0]![0]).toBe('resume_file');
    expect(port.uploadDocument.mock.calls[0]![1]).toMatchObject({ fileName: 'resume.pdf', checksumSha256: RESUME_CHECKSUM });
    // The bytes never came from a filesystem path the page could influence.
    expect(port.uploadDocument.mock.calls[0]![1].bytes).toEqual(Buffer.from('%PDF-1.4 approved bytes'));

    // MULTI-STEP: step 1 satisfied its required controls and advanced exactly once, and
    // validation state was read rather than assumed.
    expect(port.advance).toHaveBeenCalledOnce();
    expect(port.validate).toHaveBeenCalled();

    // HUMAN VERIFICATION: step 2 stopped the chain instead of answering the challenge,
    // and no answer was ever written for it.
    await expect(prisma.humanVerification.findFirstOrThrow({ where: { applicationId: chainApplicationId } }))
      .resolves.toMatchObject({ type: 'CAPTCHA', status: 'PENDING', resolution: null });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: chainApplicationId } }))
      .resolves.toMatchObject({ status: 'WAITING_FOR_USER' });

    // DURABLE EVIDENCE: one audit record per step, retaining the immutable object
    // identity, and provenance for the approved answer that was actually used.
    const audits = await prisma.auditLog.findMany({ where: { userId, resourceId: chainApplicationId, action: 'GREENHOUSE_FORM_STEP_ASSESSED' } });
    expect(audits).toHaveLength(2);
    const detailsByStep = new Map(audits.map(audit => [(audit.details as { step: number }).step, audit.details as {
      step: number;
      requiredBlockingFieldIds: string[];
      fieldsFilled: string[];
      resumeDocument: Record<string, unknown> | null;
      persistedAnswers: Array<Record<string, unknown>>;
    }]));
    expect([...detailsByStep.keys()].sort((left, right) => left - right)).toEqual([1, 2]);

    // The step 1 record proves the deferred advance was justified, not assumed: the
    // upload cleared the file blocker before the step was left.
    expect(detailsByStep.get(1)).toMatchObject({ requiredBlockingFieldIds: [], fieldsFilled: ['first_name', 'custom_question', 'resume_file'] });
    // The step 2 record proves an unresolved blocker still stops the chain.
    expect(detailsByStep.get(2)).toMatchObject({ requiredBlockingFieldIds: ['g-recaptcha-response'], fieldsFilled: [] });

    // Every step's evidence retains the same immutable object identity — checksum, kind,
    // bucket, approval and scan state — and never the object bytes or a local path.
    for (const details of detailsByStep.values()) {
      expect(details.resumeDocument).toMatchObject({
        checksumSha256: RESUME_CHECKSUM, resumeVersionId, bucket: 'private',
        kind: 'RESUME_APPROVED', approvalStatus: 'APPROVED', approvedBy: userId, scanStatus: 'CLEAN',
      });
      expect(JSON.stringify(details.resumeDocument)).not.toContain('%PDF');
    }

    const stepOneAnswers = detailsByStep.get(1)!.persistedAnswers;
    expect(stepOneAnswers.find(answer => answer.questionIdentity === 'GREENHOUSE:step_1:TEXT:custom_question:question:one'))
      .toMatchObject({ answerId: customQuestionAnswer.id, ownerId: userId, source: 'USER_INPUT', approved: true });
    expect(stepOneAnswers.find(answer => answer.questionIdentity === 'GREENHOUSE:step_1:TEXT:first_name:first_name:one'))
      .toMatchObject({ ownerId: userId, source: 'USER_PROFILE', approved: true });
    // The resume upload is evidence on the application, never an answer row.
    await expect(prisma.applicationAnswer.count({ where: { applicationId: chainApplicationId } })).resolves.toBe(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
