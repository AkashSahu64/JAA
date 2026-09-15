import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { claimDueSearchSchedules } from './durable-scheduler';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable scheduler persistence', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const recurringProfileId = randomUUID();
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
});
