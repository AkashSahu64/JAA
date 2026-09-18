import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { ApplicationCreationError, createApplicationIntent } from './application-creation';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function fixture(userId: string, suffix: string) {
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const profileId = randomUUID();
  return { userId, suffix, jobId, resumeId, versionId, profileId };
}

async function createFixture(ids: ReturnType<typeof fixture>) {
  await prisma.searchProfile.create({ data: { id: ids.profileId, userId: ids.userId, name: `Profile ${ids.suffix}`, targetRoles: ['Platform Engineer'], sources: ['fixture'], minMatchScore: 80, minATSScore: 85, maxApplicationsPerDay: 2 } });
  await prisma.job.create({ data: { id: ids.jobId, source: 'fixture', sourceJobId: randomUUID(), company: `Company ${ids.suffix}`, title: 'Platform Engineer', description: 'Build reliable services.', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
  await prisma.resume.create({ data: { id: ids.resumeId, userId: ids.userId, name: `Resume ${ids.suffix}`, content: 'Approved candidate facts.' } });
  await prisma.resumeVersion.create({ data: { id: ids.versionId, resumeId: ids.resumeId, jobId: ids.jobId, content: 'EXPERIENCE\n• Platform Engineer', atsScoreOverall: 90, atsScoreData: { version: 'deterministic-ats/1.0.0' }, sourceFacts: [{ sourceFactId: randomUUID(), sourceChecksum: 'a'.repeat(64) }] } });
  await prisma.jobMatch.create({ data: { userId: ids.userId, jobId: ids.jobId, overall: 90, tier: 'HIGH', matchingVersion: 'deterministic-match/1.0.0', evidence: {}, profileHash: 'b'.repeat(64), jobHash: 'c'.repeat(64) } });
}

function input(ids: ReturnType<typeof fixture>, idempotencyKey = `application-create:${ids.suffix}`) {
  return {
    userId: ids.userId,
    jobId: ids.jobId,
    resumeVersionId: ids.versionId,
    searchProfileId: ids.profileId,
    correlationId: `correlation:${ids.suffix}`,
    idempotencyKey,
  };
}

describeDatabase.sequential('application creation', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const primary = fixture(userId, 'primary');
  const competing = fixture(userId, 'competing');
  const other = fixture(otherUserId, 'other');
  // Fixtures created inside individual tests still need cleanup; jobs are not
  // user-owned, so deleting the candidate does not remove them.
  const createdJobIds = new Set<string>([primary.jobId, competing.jobId, other.jobId]);

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Creation Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Creation Fixture' },
    ] });
    await Promise.all([createFixture(primary), createFixture(competing), createFixture(other)]);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    // Jobs are not user-owned, so the cascade above does not remove these fixtures.
    await prisma.job.deleteMany({ where: { id: { in: [...createdJobIds] } } });
    await prisma.$disconnect();
  });

  it('creates one application and evaluation job, then replays the identical request', async () => {
    const first = await createApplicationIntent(input(primary));
    const second = await createApplicationIntent(input(primary));
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, application: { id: first.application.id }, automationJob: { id: first.automationJob.id } });
    await expect(prisma.application.count({ where: { userId, jobId: primary.jobId } })).resolves.toBe(1);
    await expect(prisma.automationJob.findUniqueOrThrow({ where: { id: first.automationJob.id } })).resolves.toMatchObject({
      applicationId: first.application.id,
      type: 'EVALUATE_APPLICATION_QUALITY',
      status: 'AVAILABLE',
      payload: { applicationId: first.application.id, searchProfileId: primary.profileId },
    });
  });

  it('serializes concurrent requests and rejects a different duplicate command', async () => {
    const requests = await Promise.all([createApplicationIntent(input(competing)), createApplicationIntent(input(competing))]);
    expect(requests.map(result => result.replayed).sort()).toEqual([false, true]);
    await expect(prisma.application.count({ where: { userId, jobId: competing.jobId } })).resolves.toBe(1);
    await expect(createApplicationIntent({ ...input(competing, 'different-command'), correlationId: 'different-correlation' }))
      .rejects.toMatchObject({ code: 'APPLICATION_EXISTS' } satisfies Partial<ApplicationCreationError>);
  });

  it('enforces resume-version ownership', async () => {
    const isolated = fixture(userId, 'cross-tenant');
    createdJobIds.add(isolated.jobId);
    await createFixture(isolated);
    await expect(createApplicationIntent({ ...input(isolated), resumeVersionId: other.versionId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<ApplicationCreationError>);
  });
});
