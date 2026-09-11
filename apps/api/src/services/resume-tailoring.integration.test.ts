import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { RESUME_TAILORING_PROMPT_VERSION, RESUME_TAILORING_SCHEMA_VERSION, type TailoredResumeResult } from '@jobagent/ai';
import { executeResumeTailoring, ResumeTailoringError } from './resume-tailoring';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

const sourceText = 'Platform Engineer at Example Company from 2021 to 2025';

describeDatabase.sequential('durable resume tailoring', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const resumeId = randomUUID();
  const jobId = randomUUID();
  let factId = '';

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Tailoring Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Fixture' },
    ] });
    await prisma.resume.create({ data: { id: resumeId, userId, name: 'Master', isMaster: true, content: sourceText } });
    await prisma.job.create({ data: { id: jobId, source: 'fixture', sourceJobId: randomUUID(), company: 'Example Company', title: 'Platform Engineer', description: 'Build TypeScript services.', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
    const fact = await prisma.resumeSourceFact.create({ data: { userId, resumeId, factType: 'EXPERIENCE', value: { text: sourceText }, sourceText, sourceStart: 0, sourceEnd: sourceText.length, checksum: 'a'.repeat(64), approved: true, approvedAt: new Date(), approvedBy: userId } });
    factId = fact.id;
  });

  afterAll(async () => {
    await prisma.resumeVersion.deleteMany({ where: { resumeId } });
    await prisma.resumeSourceFact.deleteMany({ where: { resumeId } });
    await prisma.resume.deleteMany({ where: { id: resumeId } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  function agent(claim = sourceText): Pick<any, 'tailor'> {
    const result: TailoredResumeResult = {
      schemaVersion: RESUME_TAILORING_SCHEMA_VERSION, promptVersion: RESUME_TAILORING_PROMPT_VERSION,
      claims: [{ id: 'claim-1', section: 'Experience', claim, sourceFactId: factId }],
      changesFromMaster: ['Prioritized relevant experience'], keywordsAdded: ['Platform'], sectionsReordered: true,
    };
    return { tailor: async () => result };
  }

  it('persists a tenant-scoped version with verified immutable claim provenance', async () => {
    const version = await executeResumeTailoring(userId, resumeId, jobId, agent());
    expect(version).toMatchObject({ resumeId, jobId, company: 'Example Company', role: 'Platform Engineer' });
    expect(version.jdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(version.sourceFacts).toEqual([expect.objectContaining({ sourceFactId: factId, verified: true, sourceChecksum: 'a'.repeat(64) })]);
    expect(version.content).toContain(sourceText);
  });

  it('rejects fabricated dates and never persists a version', async () => {
    await expect(executeResumeTailoring(userId, resumeId, jobId, agent('Platform Engineer at Example Company from 2020 to 2025')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CLAIMS' } satisfies Partial<ResumeTailoringError>);
  });

  it('does not allow another tenant to use the resume facts', async () => {
    await expect(executeResumeTailoring(otherUserId, resumeId, jobId, agent())).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<ResumeTailoringError>);
  });
});
