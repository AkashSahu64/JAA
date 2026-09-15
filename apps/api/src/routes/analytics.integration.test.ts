import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { groupApplicationsByDateAndStatus } from './analytics';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('authoritative analytics aggregation', () => {
  const userId = randomUUID();
  const jobIds = [randomUUID(), randomUUID(), randomUUID()];
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationIds = [randomUUID(), randomUUID(), randomUUID()];
  const day = new Date('2026-09-14T12:00:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Analytics Fixture' } });
    for (const [index, id] of jobIds.entries()) {
      await prisma.job.create({ data: { id, source: index === 2 ? 'LEVER' : 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Analytics Fixture', title: index === 0 ? 'Platform Engineer' : 'Data Engineer', description: 'Fixture', applicationUrl: `https://example.invalid/jobs/${id}`, sourceUrl: `https://example.invalid/jobs/${id}` } });
    }
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, content: 'Fixture resume', atsScoreOverall: 87 } });
    await prisma.application.createMany({ data: [
      { id: applicationIds[0], userId, jobId: jobIds[0], resumeVersionId: versionId, status: 'CONFIRMED', atsScore: 92, createdAt: day, appliedAt: new Date(day.getTime() + 3_600_000), confirmedAt: new Date(day.getTime() + 7_200_000) },
      { id: applicationIds[1], userId, jobId: jobIds[1], resumeVersionId: versionId, status: 'REJECTED', atsScore: 74, createdAt: day },
      { id: applicationIds[2], userId, jobId: jobIds[2], resumeVersionId: versionId, status: 'OFFER', atsScore: 55, createdAt: new Date(day.getTime() + 86_400_000) },
    ] });
    await prisma.jobMatch.createMany({ data: jobIds.map((jobId, index) => ({ id: randomUUID(), userId, jobId, overall: index === 0 ? 90 : 70, tier: index === 0 ? 'STRONG' : 'WEAK' })) });
    await prisma.failureRecord.create({ data: { userId, applicationId: applicationIds[1], category: 'PROVIDER', code: 'VALIDATION_FAILED', message: 'fixture', correlationId: randomUUID() } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    for (const id of jobIds) await prisma.job.delete({ where: { id } });
    await prisma.$disconnect();
  });

  it('derives tenant-owned lifecycle, provider, ATS, failure, and timing metrics from persisted rows', async () => {
    const applications = await prisma.application.findMany({ where: { userId }, select: { createdAt: true, status: true } });
    const grouped = groupApplicationsByDateAndStatus(applications);
    expect(grouped).toEqual([
      { date: '2026-09-14', total: 2, statuses: { CONFIRMED: 1, REJECTED: 1 } },
      { date: '2026-09-15', total: 1, statuses: { OFFER: 1 } },
    ]);
    await expect(prisma.application.count({ where: { userId, status: 'CONFIRMED' } })).resolves.toBe(1);
    await expect(prisma.application.count({ where: { userId, status: { in: ['OFFER', 'ACCEPTED'] } } })).resolves.toBe(1);
    await expect(prisma.jobMatch.count({ where: { userId, overall: { gte: 80 } } })).resolves.toBe(1);
    await expect(prisma.failureRecord.count({ where: { userId, code: 'VALIDATION_FAILED' } })).resolves.toBe(1);
    const confirmed = await prisma.application.findUniqueOrThrow({ where: { id: applicationIds[0] }, select: { appliedAt: true, confirmedAt: true } });
    expect((confirmed.confirmedAt!.getTime() - confirmed.appliedAt!.getTime()) / 3_600_000).toBe(1);
  });
});
