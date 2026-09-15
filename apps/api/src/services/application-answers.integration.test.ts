import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { decideApplicationAnswer, saveApplicationAnswerDraft } from './application-answers';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('application answer approval boundary', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const applicationId = randomUUID();
  const questionId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Candidate Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Candidate Fixture' },
    ] });
    await prisma.job.create({ data: { id: jobId, source: 'fixture', sourceJobId: randomUUID(), title: 'Fixture role', company: 'Fixture company', description: 'Fixture', applicationUrl: `https://example.invalid/${jobId}/apply`, sourceUrl: `https://example.invalid/${jobId}` } });
    await prisma.resume.create({ data: { id: resumeId, userId, name: 'Fixture resume', isMaster: true, content: 'Fixture' } });
    await prisma.resumeVersion.create({ data: { id: resumeVersionId, resumeId, jobId, content: 'Fixture', atsScoreOverall: 90, atsScoreData: { version: 'fixture' }, sourceFacts: [] } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId, status: 'QUALIFIED' } });
    await prisma.applicationQuestion.create({ data: {
      id: questionId, userId, applicationId, externalKey: 'GREENHOUSE:step-1:TEXT:question:custom:no_options',
      label: 'Custom question', fieldType: 'TEXT', risk: 'AMBIGUOUS',
    } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('stores every draft as unapproved, including AI suggestions', async () => {
    const draft = await saveApplicationAnswerDraft({
      userId, applicationId, questionId, value: 'AI suggestion', source: 'AI_SUGGESTION', provenance: { model: 'fixture' },
    });
    expect(draft).toMatchObject({ approved: false, approvedAt: null, approvedBy: null, version: 1 });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { userId, resourceId: draft.id, action: 'APPLICATION_ANSWER_DRAFT_SAVED' } }))
      .resolves.toMatchObject({ details: expect.objectContaining({ source: 'AI_SUGGESTION', risk: 'AMBIGUOUS' }) });
  });

  it('requires an explicit tenant-scoped approval and records its approver and revision', async () => {
    const draft = await prisma.applicationAnswer.findUniqueOrThrow({ where: { questionId } });
    await expect(decideApplicationAnswer({ userId: otherUserId, applicationId, answerId: draft.id, decision: 'APPROVE' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const approved = await decideApplicationAnswer({ userId, applicationId, answerId: draft.id, decision: 'APPROVE', expectedVersion: draft.version });
    expect(approved).toMatchObject({ approved: true, approvedBy: userId, approvedAt: expect.any(Date), version: draft.version + 1 });
    await expect(prisma.auditLog.findFirstOrThrow({ where: { userId, resourceId: draft.id, action: 'APPLICATION_ANSWER_APPROVED' } }))
      .resolves.toMatchObject({ details: expect.objectContaining({ applicationId, questionId }) });
  });
});
