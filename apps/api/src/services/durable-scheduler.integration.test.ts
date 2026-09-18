import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { claimDueEmailSyncs, claimDueSearchSchedules, scheduleApplicationRun } from './durable-scheduler';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable scheduler persistence', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const recurringProfileId = randomUUID();
  const applicationJobId = randomUUID();
  const applicationResumeId = randomUUID();
  const applicationResumeVersionId = randomUUID();
  const applicationId = randomUUID();
  const emailConnectionId = randomUUID();
  const dueAt = new Date('2026-09-14T00:00:00.000Z');
  const now = new Date('2026-09-15T00:00:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Scheduler Fixture' } });
    await prisma.searchProfile.create({ data: {
      id: profileId, userId, name: 'Due fixture', targetRoles: ['Platform Engineer'], cities: ['London'],
      sources: ['GREENHOUSE'], discoveryAccounts: [{ source: 'GREENHOUSE', account: 'example' }],
      schedule: 'ONCE', nextRunAt: dueAt, isActive: true,
    } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.job.delete({ where: { id: applicationJobId } });
    await prisma.$disconnect();
  });

  it('claims an ONCE slot exactly once under concurrent workers and creates durable discovery work', async () => {
    const [first, second] = await Promise.all([
      claimDueSearchSchedules(userId, now),
      claimDueSearchSchedules(userId, now),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ profileId, scheduledAt: dueAt, nextRunAt: null });
    await expect(prisma.searchProfile.findUniqueOrThrow({ where: { id: profileId } }))
      .resolves.toMatchObject({ isActive: false, lastRunAt: now, nextRunAt: null });
    await expect(prisma.jobDiscoveryRun.count({ where: { userId, sourceAccount: 'example' } })).resolves.toBe(1);
    await expect(prisma.automationJob.count({ where: { userId, type: 'DISCOVER_JOBS' } })).resolves.toBe(1);
  });

  it('advances a recurring timezone-aware slot durably after claiming it', async () => {
    await prisma.searchProfile.create({ data: {
      id: recurringProfileId, userId, name: 'Recurring fixture', targetRoles: ['Engineer'], cities: ['London'],
      sources: ['LEVER'], discoveryAccounts: [{ source: 'LEVER', account: 'fixture-company' }],
      schedule: 'HOURLY', timeZone: 'Europe/London', nextRunAt: dueAt, isActive: true,
    } });
    const claimed = await claimDueSearchSchedules(userId, now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ profileId: recurringProfileId, scheduledAt: dueAt, schedule: 'HOURLY' });
    expect(claimed[0].nextRunAt).toBeInstanceOf(Date);
    expect(claimed[0].nextRunAt!.getTime()).toBeGreaterThan(dueAt.getTime());
    await expect(prisma.searchProfile.findUniqueOrThrow({ where: { id: recurringProfileId } }))
      .resolves.toMatchObject({ isActive: true, lastRunAt: now });
    await expect(prisma.jobDiscoveryRun.count({ where: { userId, sourceAccount: 'fixture-company' } })).resolves.toBe(1);
  });

  it('persists an owner/provider-bound application run in the durable future queue', async () => {
    await prisma.job.create({ data: {
      id: applicationJobId, source: 'lever', sourceJobId: randomUUID(), company: 'Scheduler Example', title: 'Engineer',
      description: 'Fixture role', applicationUrl: 'https://jobs.lever.co/example/scheduled/apply', sourceUrl: 'https://jobs.lever.co/example/scheduled',
    } });
    await prisma.resume.create({ data: { id: applicationResumeId, userId, name: 'Scheduler resume', content: 'Approved fixture resume' } });
    await prisma.resumeVersion.create({ data: { id: applicationResumeVersionId, resumeId: applicationResumeId, content: 'Approved fixture resume' } });
    await prisma.application.create({ data: {
      id: applicationId, userId, jobId: applicationJobId, resumeVersionId: applicationResumeVersionId, status: 'APPLICATION_STARTED',
    } });
    const runAt = new Date(now.getTime() + 60 * 60 * 1_000);

    const first = await scheduleApplicationRun({
      userId, applicationId, runAt, correlationId: 'scheduler-application-correlation', idempotencyKey: 'scheduler-application-run',
    }, now);
    const replay = await scheduleApplicationRun({
      userId, applicationId, runAt, correlationId: 'scheduler-application-correlation', idempotencyKey: 'scheduler-application-run',
    }, now);

    expect(first).toMatchObject({ replayed: false, type: 'COMPLETE_LEVER_APPLICATION', availableAt: runAt });
    expect(replay).toMatchObject({ replayed: true, id: first.id });
    await expect(prisma.automationJob.count({ where: { userId, applicationId, type: 'COMPLETE_LEVER_APPLICATION' } })).resolves.toBe(1);
    await expect(prisma.outboxEvent.findFirst({ where: { userId, idempotencyKey: `application-run-scheduled:${first.id}` } }))
      .resolves.toMatchObject({ eventType: 'application.run.scheduled', aggregateId: applicationId, payload: { provider: 'LEVER' } });
    await expect(prisma.auditLog.findFirst({ where: { userId, action: 'APPLICATION_RUN_SCHEDULED', resourceId: applicationId } }))
      .resolves.toMatchObject({ details: { provider: 'LEVER' } });
  });

  it('claims due mailbox syncs once and binds the queued job to the owner and provider', async () => {
    await prisma.emailConnection.create({ data: {
      id: emailConnectionId, userId, provider: 'GMAIL', accountLabel: 'scheduler@example.invalid',
      status: 'ACTIVE', credentialRef: 'credential-fixture',
    } });
    const [first, second] = await Promise.all([
      claimDueEmailSyncs(userId, now),
      claimDueEmailSyncs(userId, now),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ connectionId: emailConnectionId, provider: 'GMAIL' });
    await expect(prisma.automationJob.count({ where: { userId, type: 'SYNC_EMAIL_CONNECTION', payload: { path: ['connectionId'], equals: emailConnectionId } } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { userId, resource: 'EmailConnection', resourceId: emailConnectionId, action: 'EMAIL_SYNC_SCHEDULED' } })).resolves.toBe(1);
    await expect(prisma.emailConnection.findUniqueOrThrow({ where: { id: emailConnectionId } })).resolves.toMatchObject({ lastSyncAt: null });
  });
});
