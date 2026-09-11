import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { executeJobMatch } from './job-matching';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('deterministic job match persistence', () => {
  const userId = randomUUID();
  const jobId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Match Fixture' } });
    await prisma.userProfile.create({ data: {
      userId, fullName: 'Match Fixture', email: `${userId}@example.invalid`, yearsOfExperience: 6,
      currentRole: 'Platform Engineer', targetRoles: ['Platform Engineer'], seniority: 'Senior',
      skills: { programming: ['TypeScript'], databases: ['PostgreSQL'], cloud: ['AWS'] },
      experience: [{ company: 'Fixture', position: 'Platform Engineer', technologies: ['TypeScript', 'PostgreSQL', 'AWS'], responsibilities: ['Own services'] }],
      education: [{ degree: 'Bachelor', field: 'Computer Science' }], certifications: [], locationPreferences: ['remote'],
      salaryPreference: { max: 180000 }, workAuthorized: true, sponsorshipNeeded: false,
    } });
    await prisma.job.create({ data: {
      id: jobId, source: 'fixture', sourceJobId: randomUUID(), company: 'Fixture', title: 'Platform Engineer',
      description: 'Build TypeScript services.', requirements: ['Bachelor degree'], skills: ['TypeScript', 'PostgreSQL'],
      remoteType: 'Remote', seniority: 'Senior', experienceMin: 5, salaryMin: 150000,
      applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job',
    } });
  });

  afterAll(async () => {
    await prisma.job.delete({ where: { id: jobId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('upserts reproducible evidence, input hashes, and bounded dimensions for its tenant', async () => {
    const first = await executeJobMatch(userId, jobId);
    const second = await executeJobMatch(userId, jobId);

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ userId, jobId, matchingVersion: 'deterministic-match/1.0.0', tier: expect.any(String) });
    expect(second.overall).toBeGreaterThanOrEqual(0);
    expect(second.overall).toBeLessThanOrEqual(100);
    expect(second.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.jobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.evidence).toMatchObject({ version: 'deterministic-match/1.0.0', matchedSkills: expect.any(Array), dimensions: expect.any(Object) });
  });
});
