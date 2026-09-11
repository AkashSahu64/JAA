import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { authorizeSubmission, recordAuthorizedSubmissionHandoff, SubmissionEngineError } from './submission-engine';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function ids(userId: string, suffix: string) {
  return { userId, suffix, jobId: randomUUID(), resumeId: randomUUID(), versionId: randomUUID(), applicationId: randomUUID(), factId: randomUUID() };
}

async function createFixture(input: ReturnType<typeof ids>, requiredQuestion = false) {
  await prisma.job.create({ data: { id: input.jobId, source: 'fixture', sourceJobId: randomUUID(), company: `Company ${input.suffix}`, title: 'Engineer', description: 'Build services.', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
  await prisma.resume.create({ data: { id: input.resumeId, userId: input.userId, content: 'Source resume.' } });
  await prisma.objectMetadata.create({ data: { userId: input.userId, resumeId: input.resumeId, bucket: 'private', objectKey: `fixture/${input.suffix}`, kind: 'RESUME_SOURCE', fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(42), checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN' } });
  await prisma.resumeSourceFact.create({ data: { id: input.factId, userId: input.userId, resumeId: input.resumeId, factType: 'experience', value: {}, sourceText: 'Source resume.', checksum: 'b'.repeat(64), approved: true } });
  await prisma.resumeVersion.create({ data: { id: input.versionId, resumeId: input.resumeId, jobId: input.jobId, content: 'EXPERIENCE\n• Engineer', atsScoreOverall: 90, atsScoreData: { version: 'fixture' }, sourceFacts: [{ sourceFactId: input.factId, sourceChecksum: 'b'.repeat(64) }] } });
  await prisma.application.create({ data: { id: input.applicationId, userId: input.userId, jobId: input.jobId, resumeVersionId: input.versionId, status: 'READY_TO_SUBMIT' } });
  await prisma.applicationQualityDecision.create({ data: { userId: input.userId, applicationId: input.applicationId, decision: 'PASS', version: 'fixture', evidence: {}, inputHash: randomUUID() } });
  if (requiredQuestion) {
    await prisma.applicationQuestion.create({ data: { userId: input.userId, applicationId: input.applicationId, externalKey: 'required', label: 'Required question', fieldType: 'TEXT', required: true, risk: 'SAFE' } });
  }
}

describeDatabase.sequential('submission authorization', () => {
  const userId = randomUUID();
  const ready = ids(userId, 'ready');
  const incomplete = ids(userId, 'incomplete');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Submission Fixture' } });
    await createFixture(ready);
    await createFixture(incomplete, true);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('records immutable preflight evidence, queues a handoff, and stops unconfirmed', async () => {
    const input = { userId, applicationId: ready.applicationId, expectedVersion: 1, idempotencyKey: 'submission-ready', correlationId: 'submission-ready' };
    const first = await authorizeSubmission(input);
    const replay = await authorizeSubmission(input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, authorization: { id: first.authorization.id } });
    expect(first.authorization.preflightEvidence).toMatchObject({ resumeVersionId: ready.versionId });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: ready.applicationId } })).resolves.toMatchObject({ status: 'SUBMISSION_PENDING', version: 2 });
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: first.automationJob.id } })).resolves.toMatchObject({ type: 'RECORD_AUTHORIZED_SUBMISSION_HANDOFF', maxAttempts: 1 });

    const handoff = await recordAuthorizedSubmissionHandoff({ userId, authorizationId: first.authorization.id, correlationId: input.correlationId });
    expect(handoff.replayed).toBe(false);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: ready.applicationId } })).resolves.toMatchObject({ status: 'UNCONFIRMED', version: 3, confirmedAt: null });
    await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: first.authorization.id } })).resolves.toMatchObject({ status: 'CONSUMED', consumedAt: expect.any(Date) });
  });

  it('fails closed when a required answer has no reviewed provenance', async () => {
    await expect(authorizeSubmission({ userId, applicationId: incomplete.applicationId, expectedVersion: 1, idempotencyKey: 'submission-incomplete', correlationId: 'submission-incomplete' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<SubmissionEngineError>);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: incomplete.applicationId } })).resolves.toMatchObject({ status: 'READY_TO_SUBMIT', version: 1 });
  });
});
