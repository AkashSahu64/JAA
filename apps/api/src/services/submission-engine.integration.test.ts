import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { authorizeSubmission, executeAuthorizedSubmission, reconcileStaleSubmissionAuthorizations, SubmissionEngineError } from './submission-engine';
import { ProviderSubmissionError } from './provider-submission';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function ids(userId: string, suffix: string) {
  return { userId, suffix, jobId: randomUUID(), resumeId: randomUUID(), versionId: randomUUID(), applicationId: randomUUID(), factId: randomUUID() };
}

async function createFixture(input: ReturnType<typeof ids>, requiredQuestion = false) {
  const checksum = createHash('sha256').update(input.suffix).digest('hex');
  await prisma.job.create({ data: { id: input.jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: `Company ${input.suffix}`, title: 'Engineer', description: 'Build services.', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
  await prisma.resume.create({ data: { id: input.resumeId, userId: input.userId, content: 'Source resume.' } });
  await prisma.resumeSourceFact.create({ data: { id: input.factId, userId: input.userId, resumeId: input.resumeId, factType: 'experience', value: {}, sourceText: 'Source resume.', checksum: 'b'.repeat(64), approved: true } });
  await prisma.resumeVersion.create({ data: { id: input.versionId, resumeId: input.resumeId, jobId: input.jobId, content: 'EXPERIENCE\n• Engineer', atsScoreOverall: 90, atsScoreData: { version: 'fixture' }, sourceFacts: [{ sourceFactId: input.factId, sourceChecksum: 'b'.repeat(64) }] } });
  await prisma.objectMetadata.create({ data: { userId: input.userId, resumeId: input.resumeId, resumeVersionId: input.versionId, bucket: 'private', objectKey: `private/resume_source/${input.userId}/${checksum}`, kind: 'RESUME_SOURCE', fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(42), checksumSha256: checksum, encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: input.userId } });
  await prisma.application.create({ data: { id: input.applicationId, userId: input.userId, jobId: input.jobId, resumeVersionId: input.versionId, status: 'READY_TO_SUBMIT' } });
  await prisma.applicationQualityDecision.create({ data: { userId: input.userId, applicationId: input.applicationId, decision: 'PASS', version: 'fixture', evidence: {}, inputHash: 'c'.repeat(64) } });
  if (requiredQuestion) await prisma.applicationQuestion.create({ data: { userId: input.userId, applicationId: input.applicationId, externalKey: 'required', label: 'Required question', fieldType: 'TEXT', required: true, risk: 'SAFE' } });
}

describeDatabase.sequential('submission engine', () => {
  const userId = randomUUID();
  const ready = ids(userId, 'ready');
  const unknown = ids(userId, 'unknown');
  const failed = ids(userId, 'failed');
  const incomplete = ids(userId, 'incomplete');
  const stale = ids(userId, 'stale');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Submission Fixture' } });
    await prisma.userProfile.create({ data: { userId, fullName: 'Submission Fixture', email: `${userId}@example.invalid` } });
    await createFixture(ready);
    await createFixture(unknown);
    await createFixture(failed);
    await createFixture(incomplete, true);
    await createFixture(stale);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('records immutable preflight evidence, executes exactly once, and remains unconfirmed', async () => {
    const input = { userId, applicationId: ready.applicationId, expectedVersion: 1, idempotencyKey: 'submission-ready', correlationId: 'submission-ready' };
    const first = await authorizeSubmission(input);
    const replay = await authorizeSubmission(input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, authorization: { id: first.authorization.id } });
    expect(first.authorization.preflightEvidence).toMatchObject({ resumeVersionId: ready.versionId });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: ready.applicationId } })).resolves.toMatchObject({ status: 'SUBMISSION_PENDING', version: 2 });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: first.automationJob.id } })).resolves.toMatchObject({ type: 'EXECUTE_AUTHORIZED_SUBMISSION', maxAttempts: 1 });

    const executor = { execute: async () => ({ provider: 'GREENHOUSE' as const, attemptedAt: new Date() }) };
    const attempted = await executeAuthorizedSubmission({ userId, authorizationId: first.authorization.id, correlationId: input.correlationId, workerId: 'fixture-worker' }, executor);
    expect(attempted.replayed).toBe(false);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: ready.applicationId } })).resolves.toMatchObject({ status: 'UNCONFIRMED', version: 3, confirmedAt: null });
    await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: first.authorization.id } })).resolves.toMatchObject({ status: 'CONSUMED', consumedAt: expect.any(Date) });
    const attempt = await prisma.applicationAttempt.findFirstOrThrow({ where: { applicationId: ready.applicationId } });
    expect(attempt.logs).toEqual(expect.arrayContaining([expect.objectContaining({
      resumeDocument: expect.objectContaining({ resumeVersionId: ready.versionId }),
    })]));
    await expect(prisma.auditLog.findFirst({ where: { userId, action: 'SUBMISSION_ATTEMPTED', resourceId: first.authorization.id } })).resolves.not.toBeNull();
  });

  it('forbids retry when provider outcome is indeterminate', async () => {
    const authorization = await authorizeSubmission({ userId, applicationId: unknown.applicationId, expectedVersion: 1, idempotencyKey: 'submission-unknown', correlationId: 'submission-unknown' });
    const executor = { execute: async () => { throw new ProviderSubmissionError('UNKNOWN_OUTCOME', 'fixture timeout after click'); } };
    await expect(executeAuthorizedSubmission({ userId, authorizationId: authorization.authorization.id, correlationId: 'submission-unknown', workerId: 'fixture-worker' }, executor))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' } satisfies Partial<SubmissionEngineError>);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: unknown.applicationId } })).resolves.toMatchObject({ status: 'UNCONFIRMED', version: 3 });
    await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: authorization.authorization.id } })).resolves.toMatchObject({ status: 'OUTCOME_UNKNOWN', consumedAt: null });
    await expect(prisma.failureRecord.findFirst({ where: { userId, applicationId: unknown.applicationId, code: 'OUTCOME_UNKNOWN' } })).resolves.not.toBeNull();
  });

  it('finalizes ordinary provider failures without stranding execution state', async () => {
    const authorization = await authorizeSubmission({ userId, applicationId: failed.applicationId, expectedVersion: 1, idempotencyKey: 'submission-failed', correlationId: 'submission-failed' });
    const executor = { execute: async () => { throw new ProviderSubmissionError('PRECONDITION_FAILED', 'fixture provider rejected the form'); } };
    await expect(executeAuthorizedSubmission({ userId, authorizationId: authorization.authorization.id, correlationId: 'submission-failed', workerId: 'fixture-worker' }, executor))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<ProviderSubmissionError>);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: failed.applicationId } })).resolves.toMatchObject({ status: 'FAILED', version: 3 });
    await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: authorization.authorization.id } })).resolves.toMatchObject({ status: 'FAILED', consumedAt: expect.any(Date) });
    await expect(prisma.applicationAttempt.findFirst({ where: { applicationId: failed.applicationId } })).resolves.toMatchObject({ status: 'FAILED', completedAt: expect.any(Date) });
  });

  it('fails closed when a required answer has no reviewed provenance', async () => {
    await expect(authorizeSubmission({ userId, applicationId: incomplete.applicationId, expectedVersion: 1, idempotencyKey: 'submission-incomplete', correlationId: 'submission-incomplete' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<SubmissionEngineError>);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: incomplete.applicationId } })).resolves.toMatchObject({ status: 'READY_TO_SUBMIT', version: 1 });
  });

  it('reconciles a crashed executing submission without retrying it', async () => {
    const authorization = await authorizeSubmission({ userId, applicationId: stale.applicationId, expectedVersion: 1, idempotencyKey: 'submission-stale', correlationId: 'submission-stale' });
    const startedAt = new Date('2026-09-14T00:00:00.000Z');
    await prisma.submissionAuthorization.update({ where: { id: authorization.authorization.id }, data: { status: 'EXECUTING' } });
    await prisma.applicationAttempt.create({ data: {
      applicationId: stale.applicationId, attemptNumber: 1, status: 'EXECUTING', startedAt, logs: [],
    } });

    await expect(reconcileStaleSubmissionAuthorizations(new Date('2026-09-15T00:00:00.000Z'), 60_000)).resolves.toBeGreaterThanOrEqual(1);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: stale.applicationId } }))
      .resolves.toMatchObject({ status: 'UNCONFIRMED', version: 3 });
    await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: authorization.authorization.id } }))
      .resolves.toMatchObject({ status: 'OUTCOME_UNKNOWN', consumedAt: null });
    await expect(prisma.applicationAttempt.findFirstOrThrow({ where: { applicationId: stale.applicationId } }))
      .resolves.toMatchObject({ status: 'OUTCOME_UNKNOWN', completedAt: expect.any(Date), error: 'Submission worker became stale before outcome was known' });
    await expect(prisma.failureRecord.findFirst({ where: { applicationId: stale.applicationId, code: 'STALE_EXECUTION' } })).resolves.not.toBeNull();
  });
});
