import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { executeApplicationQuality } from './application-quality';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function fixture(userId: string, suffix: string) {
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const profileId = randomUUID();
  return { userId, suffix, jobId, resumeId, versionId, applicationId, profileId };
}

async function createFixture(ids: ReturnType<typeof fixture>, maxApplicationsPerDay = 2) {
  await prisma.searchProfile.create({ data: { id: ids.profileId, userId: ids.userId, name: `Profile ${ids.suffix}`, targetRoles: ['Platform Engineer'], sources: ['fixture'], minMatchScore: 80, minATSScore: 85, maxApplicationsPerDay } });
  await prisma.job.create({ data: { id: ids.jobId, source: 'fixture', sourceJobId: randomUUID(), company: `Company ${ids.suffix}`, title: 'Platform Engineer', description: 'Build reliable services.', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
  await prisma.resume.create({ data: { id: ids.resumeId, userId: ids.userId, name: `Resume ${ids.suffix}`, content: 'Approved candidate facts.' } });
  await prisma.resumeVersion.create({ data: { id: ids.versionId, resumeId: ids.resumeId, jobId: ids.jobId, content: 'EXPERIENCE\n• Platform Engineer', atsScoreOverall: 90, atsScoreData: { version: 'deterministic-ats/1.0.0' }, sourceFacts: [{ sourceFactId: randomUUID(), sourceChecksum: 'a'.repeat(64) }] } });
  await prisma.jobMatch.create({ data: { userId: ids.userId, jobId: ids.jobId, overall: 90, tier: 'HIGH', matchingVersion: 'deterministic-match/1.0.0', evidence: {}, profileHash: 'b'.repeat(64), jobHash: 'c'.repeat(64) } });
  await prisma.application.create({ data: { id: ids.applicationId, userId: ids.userId, jobId: ids.jobId, resumeVersionId: ids.versionId } });
}

describeDatabase.sequential('application quality persistence', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const primary = fixture(userId, 'primary');
  const other = fixture(otherUserId, 'other');
  // Fixtures created inside individual tests still need cleanup; jobs are not
  // user-owned, so deleting the candidate does not remove them.
  const createdJobIds = new Set<string>([primary.jobId, other.jobId]);

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Quality Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Quality Fixture' },
    ] });
    await createFixture(primary);
    await createFixture(other);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.job.deleteMany({ where: { id: { in: [...createdJobIds] } } });
    await prisma.$disconnect();
  });

  it('persists an idempotent PASS decision, reservation, scores, and QUALIFIED transition', async () => {
    const first = await executeApplicationQuality({ userId, applicationId: primary.applicationId, searchProfileId: primary.profileId, now: new Date('2026-09-10T12:00:00.000Z') });
    const second = await executeApplicationQuality({ userId, applicationId: primary.applicationId, searchProfileId: primary.profileId, now: new Date('2026-09-10T12:00:00.000Z') });
    expect(first.result.decision).toBe('PASS');
    expect(second.decision.id).toBe(first.decision.id);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: primary.applicationId } })).resolves.toMatchObject({ status: 'QUALIFIED', matchScore: 90, atsScore: 90 });
    await expect(prisma.dailyApplicationBudgetReservation.count({ where: { applicationId: primary.applicationId } })).resolves.toBe(1);
    await expect(prisma.applicationQualityDecision.count({ where: { applicationId: primary.applicationId } })).resolves.toBe(1);
  });

  it('enforces tenant ownership for applications and profiles', async () => {
    await expect(executeApplicationQuality({ userId, applicationId: other.applicationId, searchProfileId: primary.profileId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(executeApplicationQuality({ userId, applicationId: primary.applicationId, searchProfileId: other.profileId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serializes concurrent PASS decisions against the daily limit', async () => {
    const limited = fixture(userId, 'limited');
    const competing = fixture(userId, 'competing');
    createdJobIds.add(limited.jobId);
    createdJobIds.add(competing.jobId);
    await createFixture(limited, 2);
    await createFixture(competing, 2);
    const now = new Date('2026-09-10T12:00:00.000Z');
    const [left, right] = await Promise.all([
      executeApplicationQuality({ userId, applicationId: limited.applicationId, searchProfileId: limited.profileId, now }),
      executeApplicationQuality({ userId, applicationId: competing.applicationId, searchProfileId: competing.profileId, now }),
    ]);
    expect([left.result.decision, right.result.decision].sort()).toEqual(['PASS', 'SKIPPED']);
    await expect(prisma.dailyApplicationBudgetReservation.count({ where: { userId, day: now } })).resolves.toBe(2);
  });
});
