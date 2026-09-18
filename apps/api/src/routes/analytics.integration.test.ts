import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { generateToken } from '@jobagent/security';
import { createApp } from '../app';
import { groupApplicationsByDateAndStatus } from './analytics';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('authoritative analytics aggregation', () => {
  const app = createApp();
  const userId = randomUUID();
  const jobIds = [randomUUID(), randomUUID(), randomUUID()];
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationIds = [randomUUID(), randomUUID(), randomUUID()];
  const day = new Date('2026-09-14T12:00:00.000Z');
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Analytics Fixture' } });
    for (const [index, id] of jobIds.entries()) {
      await prisma.job.create({ data: { id, source: index === 2 ? 'LEVER' : index === 0 ? 'greenhouse' : 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Analytics Fixture', title: index === 0 ? 'Platform Engineer' : 'Data Engineer', description: 'Fixture', applicationUrl: `https://example.invalid/jobs/${id}`, sourceUrl: `https://example.invalid/jobs/${id}` } });
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
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Analytics fixture server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

  it('serves the persisted analytics through authenticated tenant-scoped routes', async () => {
    const token = generateToken({ userId, email: `${userId}@example.invalid` });
    const headers = { authorization: `Bearer ${token}` };
    const dashboard = await fetch(`${baseUrl}/api/analytics/dashboard`, { headers });
    expect(dashboard.status).toBe(200);
    const dashboardBody = await dashboard.json() as { success: boolean; data: { submissionSuccessRate: number; providerMetrics: Record<string, { total: number; confirmed: number }> } };
    expect(dashboardBody).toMatchObject({ success: true, data: { submissionSuccessRate: expect.any(Number), providerMetrics: { GREENHOUSE: { total: 2, confirmed: 1 }, LEVER: { total: 1, confirmed: 0 } } } });

    const timeline = await fetch(`${baseUrl}/api/analytics/applications-over-time?days=30`, { headers });
    expect(timeline.status).toBe(200);
    const timelineBody = await timeline.json() as { success: boolean; data: Array<{ date: string; count: number }> };
    expect(timelineBody).toEqual({ success: true, data: [
      { date: '2026-09-14', count: 2 },
      { date: '2026-09-15', count: 1 },
    ] });

    const funnel = await fetch(`${baseUrl}/api/analytics/applications-funnel?days=30`, { headers });
    expect(funnel.status).toBe(200);
    const funnelBody = await funnel.json() as { success: boolean; data: Array<{ date: string; total: number; statuses: Record<string, number> }> };
    expect(funnelBody).toEqual({ success: true, data: [
      { date: '2026-09-14', total: 2, statuses: { CONFIRMED: 1, REJECTED: 1 } },
      { date: '2026-09-15', total: 1, statuses: { OFFER: 1 } },
    ] });
  });

  it('paginates analytics beyond one database page without dropping lifecycle rows', async () => {
    const scaleJobs = Array.from({ length: 1_001 }, () => randomUUID());
    try {
      await prisma.job.createMany({ data: scaleJobs.map((id) => ({
        id, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Analytics Scale Fixture', title: 'Engineer',
        description: 'Fixture', applicationUrl: `https://example.invalid/jobs/${id}`, sourceUrl: `https://example.invalid/jobs/${id}`,
      })) });
      await prisma.application.createMany({ data: scaleJobs.map((jobId) => ({
        userId, jobId, resumeVersionId: versionId, status: 'APPLICATION_STARTED' as const, createdAt: day,
      })) });

      const token = generateToken({ userId, email: `${userId}@example.invalid` });
      const response = await fetch(`${baseUrl}/api/analytics/applications-funnel?days=30`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; data: Array<{ date: string; total: number; statuses: Record<string, number> }> };
      expect(body.data).toEqual(expect.arrayContaining([
        { date: '2026-09-14', total: 1_003, statuses: { APPLICATION_STARTED: 1_001, CONFIRMED: 1, REJECTED: 1 } },
        { date: '2026-09-15', total: 1, statuses: { OFFER: 1 } },
      ]));
    } finally {
      await prisma.application.deleteMany({ where: { userId, jobId: { in: scaleJobs } } });
      await prisma.job.deleteMany({ where: { id: { in: scaleJobs } } });
    }
  });

  it('paginates dashboard interview, offer, and attempt aggregates beyond one page', async () => {
    const scaleInterviews = Array.from({ length: 1_001 }, (_, index) => ({
      applicationId: applicationIds[0], userId, type: 'Technical', company: 'Analytics Fixture', role: 'Engineer', round: index % 3 + 1,
      sourceEventId: `analytics-scale-interview-${index}`,
    }));
    const scaleOffers = Array.from({ length: 1_001 }, (_, index) => ({
      applicationId: applicationIds[0], userId, company: 'Analytics Fixture', role: 'Engineer', status: index % 2 ? 'PENDING' : 'ACCEPTED',
      sourceEventId: `analytics-scale-offer-${index}`,
    }));
    const scaleAttempts = Array.from({ length: 1_001 }, (_, index) => ({
      applicationId: applicationIds[0], attemptNumber: index + 1, status: 'CONFIRMED',
      startedAt: day, completedAt: new Date(day.getTime() + 3_600_000),
    }));
    try {
      await prisma.interview.createMany({ data: scaleInterviews });
      await prisma.offer.createMany({ data: scaleOffers });
      await prisma.applicationAttempt.createMany({ data: scaleAttempts });
      const token = generateToken({ userId, email: `${userId}@example.invalid` });
      const response = await fetch(`${baseUrl}/api/analytics/dashboard`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; data: { interviewRounds: { total: number }; offerOutcomes: { total: number }; averageTimeToSubmissionHours: number } };
      expect(body).toMatchObject({ success: true, data: { interviewRounds: { total: 1_001 }, offerOutcomes: { total: 1_001 }, averageTimeToSubmissionHours: 1 } });
    } finally {
      await prisma.applicationAttempt.deleteMany({ where: { applicationId: applicationIds[0] } });
      await prisma.interview.deleteMany({ where: { userId, sourceEventId: { startsWith: 'analytics-scale-interview-' } } });
      await prisma.offer.deleteMany({ where: { userId, sourceEventId: { startsWith: 'analytics-scale-offer-' } } });
    }
  });
});
