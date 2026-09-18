import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { applyEmailOutcome, ingestEmailOutcome, linkEmailOutcome, reviewEmailOutcome } from './email-outcomes';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable email outcome ingestion', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const receivedAt = new Date('2026-09-14T00:00:00.000Z');
  const message = {
    userId, source: 'FIXTURE_MAIL', messageId: `message-${randomUUID()}`,
    sender: 'recruiting@example.invalid', subject: 'Application received',
    body: 'We received your application. Private body marker must not be persisted.', receivedAt, applicationId,
  };
  const rejectionMessage = {
    userId, source: 'FIXTURE_MAIL', messageId: `rejection-${randomUUID()}`,
    sender: 'recruiting@example.invalid', subject: 'Application update',
    body: 'We decided not to proceed with your application.', receivedAt: new Date('2026-09-15T00:00:00.000Z'), applicationId,
  };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Email Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume' } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'CONFIRMED', appliedAt: receivedAt, confirmedAt: receivedAt } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    // Jobs are not user-owned, so removing the candidate does not remove this fixture.
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.$disconnect();
  });

  it('persists hash-only classified evidence and replays identical delivery', async () => {
    const first = await ingestEmailOutcome(message);
    const replay = await ingestEmailOutcome(message);
    expect(first).toMatchObject({ id: expect.any(String), classification: 'APPLICATION_RECEIVED', confidence: 'HIGH' });
    expect(replay.id).toBe(first.id);
    await expect(prisma.emailOutcome.count({ where: { userId, messageId: message.messageId } })).resolves.toBe(1);
    await expect(prisma.outboxEvent.count({ where: { userId, aggregateType: 'EmailOutcome', aggregateId: first.id } })).resolves.toBe(1);
    const stored = await prisma.emailOutcome.findUniqueOrThrow({ where: { id: first.id } });
    expect(JSON.stringify(stored)).not.toContain('Private body marker');
    await expect(ingestEmailOutcome({ ...message, body: 'A different delivery body' })).rejects.toThrow('conflicts');
  });

  it('requires explicit review before applying an actionable outcome to lifecycle state', async () => {
    const outcome = await ingestEmailOutcome(rejectionMessage);
    await expect(applyEmailOutcome({ userId, outcomeId: outcome.id, expectedVersion: 1, idempotencyKey: 'email-rejection-apply', correlationId: 'email-rejection-apply' }))
      .rejects.toThrow('explicitly reviewed');
    await expect(reviewEmailOutcome(userId, outcome.id)).resolves.toMatchObject({ id: outcome.id, applicationId });
    const applied = await applyEmailOutcome({ userId, outcomeId: outcome.id, expectedVersion: 1, idempotencyKey: 'email-rejection-apply', correlationId: 'email-rejection-apply' });
    expect(applied).toMatchObject({ outcomeId: outcome.id, target: 'REJECTED', replayed: false });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: 'REJECTED', version: 2 });
    await expect(applyEmailOutcome({ userId, outcomeId: outcome.id, expectedVersion: 1, idempotencyKey: 'email-rejection-apply', correlationId: 'email-rejection-apply' }))
      .resolves.toMatchObject({ replayed: true, target: 'REJECTED' });
  });

  it('clears review state when an outcome is unlinked and requires fresh review after relinking', async () => {
    const outcome = await ingestEmailOutcome({ ...message, messageId: `link-${randomUUID()}` });
    await expect(reviewEmailOutcome(userId, outcome.id)).resolves.toMatchObject({ id: outcome.id, reviewedBy: userId });
    await expect(linkEmailOutcome(userId, outcome.id, null)).resolves.toMatchObject({ id: outcome.id, applicationId: null, reviewedAt: null, reviewedBy: null });
    await expect(reviewEmailOutcome(userId, outcome.id)).rejects.toThrow('linked to an application');
    await expect(linkEmailOutcome(userId, outcome.id, applicationId)).resolves.toMatchObject({ id: outcome.id, applicationId, reviewedAt: null, reviewedBy: null });
    await expect(reviewEmailOutcome(userId, outcome.id)).resolves.toMatchObject({ id: outcome.id, reviewedBy: userId });
  });
});
