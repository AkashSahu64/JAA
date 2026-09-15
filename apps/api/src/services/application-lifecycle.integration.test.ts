import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { decideOffer, recordInterview, recordOffer } from './application-lifecycle';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable interview and offer lifecycle', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const interviewDate = new Date('2026-09-20T10:00:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Lifecycle Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', sourceUrl: 'https://boards.greenhouse.io/example/jobs/1' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume' } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'CONFIRMED' } });
  });

  afterAll(async () => {
    await prisma.interview.deleteMany({ where: { applicationId } });
    await prisma.offer.deleteMany({ where: { applicationId } });
    await prisma.application.delete({ where: { id: applicationId } });
    await prisma.resumeVersion.delete({ where: { id: versionId } });
    await prisma.resume.delete({ where: { id: resumeId } });
    await prisma.job.delete({ where: { id: jobId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('persists interview and offer lifecycle with source-event replay', async () => {
    const interviewInput = { userId, applicationId, sourceEventId: `interview-${randomUUID()}`, date: interviewDate, type: 'TECHNICAL', company: 'Fixture', role: 'Engineer', round: 1, meetingUrl: 'https://meet.example.invalid/fixture' };
    const interview = await recordInterview(interviewInput);
    const replay = await recordInterview(interviewInput);
    expect(replay.id).toBe(interview.id);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: 'INTERVIEW', version: 2 });

    const offerInput = { userId, applicationId, sourceEventId: `offer-${randomUUID()}`, company: 'Fixture', role: 'Engineer', salaryOffered: 150_000, currency: 'USD', startDate: new Date('2026-10-01T00:00:00.000Z') };
    const offer = await recordOffer(offerInput);
    const offerReplay = await recordOffer(offerInput);
    expect(offerReplay.id).toBe(offer.id);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: 'OFFER', version: 3 });
    await expect(recordOffer({ ...offerInput, role: 'Different role' })).rejects.toThrow('conflicts');

    const decided = await decideOffer({ userId, applicationId, offerId: offer.id, decision: 'ACCEPTED', sourceEventId: `decision-${randomUUID()}` });
    expect(decided.status).toBe('ACCEPTED');
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: 'ACCEPTED', version: 4 });
    await expect(prisma.auditLog.count({ where: { userId, resource: 'Interview', resourceId: interview.id } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { userId, resource: 'Offer', resourceId: offer.id } })).resolves.toBe(2);
  });
});
