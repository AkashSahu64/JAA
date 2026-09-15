import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import { createDiscoveryRuns } from './job-discovery';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;
const analyze = vi.fn();

vi.mock('@jobagent/ai', () => ({
  JobAnalysisAgent: class {
    analyze = analyze;
  },
}));

describeDatabase.sequential('production automation job handlers', () => {
  const userId = randomUUID();
  const jobId = randomUUID();

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Handler Fixture' } });
    await prisma.job.create({
      data: {
        id: jobId,
        source: 'fixture',
        sourceJobId: randomUUID(),
        company: 'Example Company',
        title: 'Software Engineer',
        description: 'Build reliable TypeScript services.',
        applicationUrl: 'https://example.invalid/apply',
        sourceUrl: 'https://example.invalid/job',
      },
    });
  });

  afterAll(async () => {
    await prisma.automationJob.deleteMany({ where: { userId } });
    await prisma.jobDiscoveryRun.deleteMany({ where: { userId } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('atomically creates one authoritative job per deduplicated discovery account', async () => {
    const runs = await createDiscoveryRuns(userId, {
      greenhouseBoards: ['example', 'example'], leverCompanies: [], ashbyBoards: [],
      query: 'engineer',
    });
    expect(runs).toHaveLength(1);
    const automationJobs = await prisma.automationJob.findMany({
      where: { userId, type: 'DISCOVER_JOBS', correlationId: runs[0].id },
    });
    expect(automationJobs).toHaveLength(1);
    expect(automationJobs[0]).toMatchObject({
      status: 'AVAILABLE', payload: { runId: runs[0].id }, payloadVersion: 1,
      idempotencyKey: `discovery-run:${runs[0].id}`,
    });
  });

  it('registers concrete handlers and persists job analysis', async () => {
    const analysis = {
      summary: 'A reliable backend role.',
      mustHave: ['TypeScript'],
      niceToHave: ['PostgreSQL'],
      potentiallyOptional: [],
      technologyStack: ['TypeScript'],
      hiddenSignals: ['Ownership'],
      leadershipExpected: false,
      communicationLevel: 'High',
      domainExperience: '',
      teamSize: '',
      methodologies: ['Agile'],
      benefits: [],
      redFlags: [],
    };
    const result = {
      kind: 'jd-analysis' as const,
      versions: {
        schema: 'jd-analysis/1.0.0' as const,
        prompt: 'jd-analysis-prompt/1.0.0',
        provider: { name: 'fixture-provider', version: '1.0.0' },
        model: { name: 'fixture-model', version: '2026-09-10' },
      },
      contentHashes: { algorithm: 'sha256' as const, input: 'a'.repeat(64), output: 'b'.repeat(64) },
      trustBoundary: {
        input: { classification: 'untrusted-external-content' as const, source: 'https://example.invalid/job', instructionsMustBeIgnored: true as const },
        output: { classification: 'model-generated-untrusted-content' as const, runtimeValidated: true as const, safeForAutomaticAction: false as const },
      },
      metadata: {
        confidence: { overall: 0.9, fields: Object.fromEntries(Object.keys(analysis).map(key => [key, 0.9])) },
        tokens: { input: 100, output: 50, total: 150 },
        cost: { amount: 0.0025, currency: 'USD', estimated: false },
      },
      analysis,
    };
    analyze.mockResolvedValueOnce(result);
    const handlers = createProductionAutomationJobHandlers();
    expect([...handlers.keys()]).toEqual(['ANALYZE_JOB', 'MATCH_JOB', 'TAILOR_RESUME', 'EVALUATE_ATS', 'EVALUATE_APPLICATION_QUALITY', 'COMPLETE_GREENHOUSE_APPLICATION', 'COMPLETE_LEVER_APPLICATION', 'EXECUTE_AUTHORIZED_SUBMISSION', 'EMAIL_OUTCOME', 'VERIFY_SUBMISSION_CONFIRMATION', 'RESUME_APPLICATION_AFTER_VERIFICATION', 'DISCOVER_JOBS']);
    await handlers.get('ANALYZE_JOB')!({
      automationJobId: randomUUID(),
      userId,
      type: 'ANALYZE_JOB',
      payload: { jobId },
      payloadVersion: 1,
      correlationId: randomUUID(),
      deliveryGeneration: 1,
      attempt: 1,
      workerId: 'handler-test',
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
    });
    await expect(prisma.jobAnalysis.findUniqueOrThrow({ where: { jobId } }))
      .resolves.toMatchObject({
        summary: result.analysis.summary,
        mustHave: result.analysis.mustHave,
        schemaVersion: result.versions.schema,
        promptVersion: result.versions.prompt,
        providerName: result.versions.provider.name,
        modelName: result.versions.model.name,
        inputHash: result.contentHashes.input,
        outputHash: result.contentHashes.output,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costAmount: 0.0025,
        confidence: result.metadata.confidence,
        trustBoundary: result.trustBoundary,
      });
  });
});
