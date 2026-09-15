import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { ingestEmailOutcome } from './email-outcomes';

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

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Email Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume' } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'FORM_FILLED' } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
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
});
