import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import { createDiscoveryRuns } from './job-discovery';
import { prepareApplicationForForm } from './application-form-preparation';
import { claimAutomationJobs } from './automation-jobs';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;
const analyze = vi.fn();
let approvedFactId = '';

vi.mock('@jobagent/ai', async importOriginal => ({
  ...(await importOriginal()),
  JobAnalysisAgent: class {
    analyze = analyze;
  },
  ResumeTailoringAgent: class {
    tailor = async () => ({
      schemaVersion: 'resume-tailoring/1.0.0' as const,
      promptVersion: 'resume-tailoring-prompt/1.0.0' as const,
      claims: [{ id: 'claim-1', section: 'Skills', claim: 'TypeScript', sourceFactId: approvedFactId }],
      changesFromMaster: [], keywordsAdded: [], sectionsReordered: false,
    });
  },
}));

describeDatabase.sequential('production automation job handlers', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const discoveredJobId = randomUUID();
  let discoveredPersistedJobId = '';

  beforeAll(async () => {
    const staleUsers = await prisma.user.findMany({
      where: { resumes: { some: { name: 'Approved handler master' } } },
      select: { id: true },
    });
    if (staleUsers.length > 0) await prisma.user.deleteMany({ where: { id: { in: staleUsers.map(user => user.id) } } });
    approvedFactId = randomUUID();
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Handler Fixture' } });
    await prisma.userProfile.create({ data: {
      userId, fullName: 'Handler Fixture', email: `${userId}@example.invalid`, yearsOfExperience: 5,
      currentRole: 'Software Engineer', targetRoles: ['Software Engineer'], skills: { programming: ['TypeScript'] },
      experience: [], education: [], certifications: [], locationPreferences: ['remote'], workAuthorized: true,
      sponsorshipNeeded: false,
    } });
    await prisma.searchProfile.create({ data: {
      userId, name: 'Handler search profile', targetRoles: ['Software Engineer'], sources: ['GREENHOUSE'],
      minMatchScore: 0, minATSScore: 0, maxApplicationsPerDay: 5,
    } });
    const resume = await prisma.resume.create({ data: { userId, name: 'Approved handler master', isMaster: true, content: 'TypeScript experience.' } });
    await prisma.resumeSourceFact.create({ data: {
      id: approvedFactId, userId, resumeId: resume.id, factType: 'skill', value: { skill: 'TypeScript' }, sourceText: 'TypeScript',
      sourceStart: 0, sourceEnd: 10, checksum: 'c'.repeat(64), approved: true, approvedAt: new Date(), approvedBy: userId,
    } });
    await prisma.job.create({
      data: {
        id: jobId,
        source: 'GREENHOUSE',
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
    await prisma.application.deleteMany({ where: { userId } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.job.deleteMany({ where: { id: discoveredJobId } });
    if (discoveredPersistedJobId) await prisma.job.deleteMany({ where: { id: discoveredPersistedJobId } });
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
    const claimed = await claimAutomationJobs({ workerId: 'handler-discovery-test', limit: 10 });
    const claimedDiscovery = claimed.find(job => job.id === automationJobs[0].id);
    expect(claimedDiscovery).toBeDefined();
    if (!claimedDiscovery) throw new Error('Discovery fixture job was not claimed');
    const discoveryHandler = createProductionAutomationJobHandlers({
      discoveryExecutor: { discover: async () => ({
        jobs: [{
          source: 'greenhouse', sourceJobId: discoveredJobId, company: `Discovered Fixture ${userId}`, title: 'Software Engineer',
          location: 'Remote', description: 'Build TypeScript services.', applicationUrl: `https://example.invalid/apply/${discoveredJobId}`,
          sourceUrl: `https://example.invalid/jobs/${discoveredJobId}`, fingerprint: `${userId.replaceAll('-', '')}${'b'.repeat(32)}`,
          provenance: { source: 'greenhouse', tenant: userId, sourceJobId: discoveredJobId, fetchedAt: new Date().toISOString(), apiUrl: `https://example.invalid/api/${discoveredJobId}` },
        }], page: { pageSize: 100, returned: 1, hasMore: false, nextCursor: undefined },
      }) },
    }).get('DISCOVER_JOBS');
    await discoveryHandler!({
      automationJobId: claimedDiscovery.id, userId, type: 'DISCOVER_JOBS', payload: claimedDiscovery.payload, payloadVersion: claimedDiscovery.payloadVersion,
      correlationId: claimedDiscovery.correlationId, deliveryGeneration: claimedDiscovery.deliveryGeneration, attempt: claimedDiscovery.attemptCount, workerId: 'handler-discovery-test',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    await expect(prisma.jobDiscoveryRun.findUniqueOrThrow({ where: { id: runs[0].id } }))
      .resolves.toMatchObject({ status: 'SUCCEEDED', jobsCreated: 1, itemsNormalized: 1 });
    const discovered = await prisma.job.findFirstOrThrow({ where: { company: `Discovered Fixture ${userId}`, title: 'Software Engineer' } });
    expect(discovered.source).toBe('GREENHOUSE');
    discoveredPersistedJobId = discovered.id;
    const analysisJobs = await prisma.automationJob.findMany({ where: { userId, type: 'ANALYZE_JOB' } });
    const discoveredAnalysis = analysisJobs.find(job => (job.payload as { jobId?: string }).jobId === discovered.id);
    expect(discoveredAnalysis).toMatchObject({ status: 'AVAILABLE', payload: { jobId: discovered.id } });
  });

  it('registers concrete handlers and persists job analysis', async () => {
    const pipelineJobId = discoveredPersistedJobId || jobId;
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
    expect([...handlers.keys()]).toEqual(['ANALYZE_JOB', 'MATCH_JOB', 'TAILOR_RESUME', 'EVALUATE_ATS', 'EVALUATE_APPLICATION_QUALITY', 'COMPLETE_GREENHOUSE_APPLICATION', 'COMPLETE_LEVER_APPLICATION', 'EXECUTE_AUTHORIZED_SUBMISSION', 'EMAIL_OUTCOME', 'SYNC_EMAIL_CONNECTION', 'VERIFY_SUBMISSION_CONFIRMATION', 'RESUME_APPLICATION_AFTER_VERIFICATION', 'DISCOVER_JOBS']);
    await handlers.get('ANALYZE_JOB')!({
      automationJobId: randomUUID(),
      userId,
      type: 'ANALYZE_JOB',
      payload: { jobId: pipelineJobId },
      payloadVersion: 1,
      correlationId: randomUUID(),
      deliveryGeneration: 1,
      attempt: 1,
      workerId: 'handler-test',
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
    });
    await expect(prisma.jobAnalysis.findUniqueOrThrow({ where: { jobId: pipelineJobId } }))
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
    await expect(prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'MATCH_JOB', idempotencyKey: `match-job:${userId}:${pipelineJobId}:${result.contentHashes.input}` },
    })).resolves.toMatchObject({
      status: 'AVAILABLE', payload: { jobId: pipelineJobId },
      correlationId: `match:${pipelineJobId}:${result.contentHashes.input}`,
    });
    await handlers.get('MATCH_JOB')!({
      automationJobId: randomUUID(), userId, type: 'MATCH_JOB', payload: { jobId: pipelineJobId }, payloadVersion: 1,
      correlationId: `match:${pipelineJobId}:${result.contentHashes.input}`, deliveryGeneration: 1, attempt: 1,
      workerId: 'handler-match-test', signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    await expect(prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'TAILOR_RESUME', idempotencyKey: { startsWith: `tailor-resume:${userId}:` } },
    })).resolves.toMatchObject({ status: 'AVAILABLE', payload: { jobId: pipelineJobId } });
    const tailoringJob = await prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'TAILOR_RESUME', idempotencyKey: { startsWith: `tailor-resume:${userId}:` } },
    });
    await handlers.get('TAILOR_RESUME')!({
      automationJobId: tailoringJob.id, userId, type: 'TAILOR_RESUME', payload: tailoringJob.payload, payloadVersion: 1,
      correlationId: tailoringJob.correlationId, deliveryGeneration: 1, attempt: 1, workerId: 'handler-tailor-test',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    await expect(prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'EVALUATE_ATS', idempotencyKey: { startsWith: `evaluate-ats:${userId}:` } },
    })).resolves.toMatchObject({ status: 'AVAILABLE', payload: { resumeVersionId: expect.any(String) } });
    const atsJob = await prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'EVALUATE_ATS', idempotencyKey: { startsWith: `evaluate-ats:${userId}:` } },
    });
    await handlers.get('EVALUATE_ATS')!({
      automationJobId: atsJob.id, userId, type: 'EVALUATE_ATS', payload: atsJob.payload, payloadVersion: 1,
      correlationId: atsJob.correlationId, deliveryGeneration: 1, attempt: 1, workerId: 'handler-ats-test',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    const application = await prisma.application.findFirstOrThrow({ where: { userId, jobId: pipelineJobId } });
    expect(application.resumeVersionId).toBe((atsJob.payload as { resumeVersionId: string }).resumeVersionId);
    await expect(prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'EVALUATE_APPLICATION_QUALITY', applicationId: application.id },
    })).resolves.toMatchObject({ status: 'AVAILABLE', payload: { applicationId: application.id } });
    const qualityJob = await prisma.automationJob.findFirstOrThrow({
      where: { userId, type: 'EVALUATE_APPLICATION_QUALITY', applicationId: application.id },
    });
    await handlers.get('EVALUATE_APPLICATION_QUALITY')!({
      automationJobId: qualityJob.id, userId, type: 'EVALUATE_APPLICATION_QUALITY', payload: qualityJob.payload, payloadVersion: 1,
      correlationId: qualityJob.correlationId, deliveryGeneration: 1, attempt: 1, workerId: 'handler-quality-test',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: application.id } }))
      .resolves.toMatchObject({ status: 'QUALIFIED', qualityScore: expect.objectContaining({ decision: 'PASS' }) });
    await expect(prepareApplicationForForm({
      userId, applicationId: application.id, idempotencyKey: `prepare-form-without-document:${application.id}`,
      correlationId: `prepare-form-without-document:${application.id}`,
    })).rejects.toMatchObject({ code: 'PRECONDITION' });
    const resumeVersionId = (atsJob.payload as { resumeVersionId: string }).resumeVersionId;
    const documentChecksum = 'a'.repeat(64);
    await prisma.objectMetadata.create({
      data: {
        userId, resumeVersionId, kind: 'RESUME_TAILORED', bucket: 'private-documents',
        objectKey: `private/resume_tailored/${userId}/${documentChecksum}`, versionId: null,
        fileName: 'tailored-resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(16),
        checksumSha256: documentChecksum, encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN',
        approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId,
      },
    });
    const prepared = await prepareApplicationForForm({
      userId, applicationId: application.id, idempotencyKey: `prepare-form:${application.id}`,
      correlationId: `prepare-form-correlation:${application.id}`,
    });
    expect(prepared.application.status).toBe('APPLICATION_STARTED');
    expect(prepared.automationJob).toMatchObject({ type: 'COMPLETE_GREENHOUSE_APPLICATION', status: 'AVAILABLE', payload: { applicationId: application.id } });
    await expect(prisma.auditLog.findFirstOrThrow({
      where: { userId, action: 'APPLICATION_FORM_PREPARATION_QUEUED', resourceId: application.id },
      orderBy: { timestamp: 'desc' },
    })).resolves.toMatchObject({
      details: expect.objectContaining({
        resumeDocument: expect.objectContaining({
          resumeVersionId, checksumSha256: documentChecksum, objectKey: `private/resume_tailored/${userId}/${documentChecksum}`,
        }),
      }),
    });
    const replay = await prepareApplicationForForm({
      userId, applicationId: application.id, idempotencyKey: `prepare-form:${application.id}`,
      correlationId: `prepare-form-correlation:${application.id}`,
    });
    expect(replay.application.version).toBe(prepared.application.version);
    expect(replay.automationJob.id).toBe(prepared.automationJob.id);
    expect(replay.automationJob.replayed).toBe(true);
  });
});
