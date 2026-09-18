import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { chromium } from 'playwright';
import { prisma, withTenant } from '@jobagent/database';
import { generateToken } from '@jobagent/security';
import { GreenhouseApplicationAdapter } from '@jobagent/job-engine';
import { ResumeParser } from '@jobagent/resume-engine';
import { createApp } from '../app';
import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';
import { verifyProviderConfirmation } from './submission-verification';
import { consumeNotificationOutboxEvent } from './notification-outbox-consumer';
import type { OutboxEnvelope } from './outbox-publisher';
import { GreenhouseApplicationService } from './greenhouse-application';
import { resolveHumanVerification, resumeHumanVerification } from './human-verification';
import { ProviderSubmissionService } from './provider-submission';
import { executeAuthorizedSubmission } from './submission-engine';
import { authorizeSubmission } from './submission-engine';
import { transitionApplicationInTenant } from './application-state-machine';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import { canonicalDiscoveryJobIdentity, createDiscoveryRuns, executeDiscoveryRun } from './job-discovery';
import { prepareApplicationForForm } from './application-form-preparation';

const analyze = vi.fn();
const e2eApprovedFactId = randomUUID();

vi.mock('@jobagent/ai', async importOriginal => ({
  ...(await importOriginal()),
  JobAnalysisAgent: class { analyze = analyze; },
  ResumeTailoringAgent: class {
    tailor = async () => ({
      schemaVersion: 'resume-tailoring/1.0.0' as const,
      promptVersion: 'resume-tailoring-prompt/1.0.0' as const,
      claims: [{ id: 'e2e-claim-1', section: 'Skills', claim: 'TypeScript', sourceFactId: e2eApprovedFactId }],
      changesFromMaster: [], keywordsAdded: ['TypeScript'], sectionsReordered: false,
    });
  },
}));

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const executable = () => {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const version = existsSync(root) ? readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort().at(-1) : undefined;
  return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (version ? join(root, version, 'chrome-win64', 'chrome.exe') : chromium.executablePath());
};
const describeE2E = enabled && existsSync(executable()) ? describe : describe.skip;

describeE2E.sequential('local autonomous submission certification slice', () => {
  const userId = randomUUID();
  const jobId = randomUUID();
  const browserJobId = randomUUID();
  const sourceJobId = randomUUID();
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const verificationJobId = randomUUID();
  const providerJobId = randomUUID();
  const verificationApplicationId = randomUUID();
  const providerApplicationId = randomUUID();
  const providerAuthorizationId = randomUUID();
  const providerObjectId = randomUUID();
  const tailoredObjectId = randomUUID();
  let verificationId = '';
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let apiServer: ReturnType<ReturnType<typeof createApp>['listen']>;
  let apiBaseUrl = '';

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'E2E Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: canonicalDiscoveryJobIdentity('fixture', sourceJobId), fingerprint: createHash('sha256').update(`GREENHOUSE:${sourceJobId}`).digest('hex'), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/1', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/1' } });
    await prisma.job.create({ data: { id: browserJobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Browser Fixture', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/browser', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/browser' } });
    await prisma.job.create({ data: { id: verificationJobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Verification Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/2', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/2' } });
    await prisma.job.create({ data: { id: providerJobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Provider Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/3', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/3' } });
    await prisma.userProfile.create({ data: {
      userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid', currentRole: 'Engineer',
      yearsOfExperience: 5, targetRoles: ['Engineer'], skills: { programming: ['TypeScript'] },
      locationPreferences: ['remote'], workAuthorized: true, sponsorshipNeeded: false,
    } });
    await prisma.searchProfile.create({ data: {
      userId, name: 'E2E fixture search', targetRoles: ['Engineer'], sources: ['GREENHOUSE'],
      minMatchScore: 0, minATSScore: 0, maxApplicationsPerDay: 5,
    } });
    const parsedResume = await new ResumeParser().parseBuffer(Buffer.from('Ada Lovelace\n\nSkills\nTypeScript\n'), 'ada-lovelace.txt');
    expect(parsedResume.sections).toEqual([expect.objectContaining({ name: 'Skills', content: 'TypeScript' })]);
    await prisma.resume.create({ data: { id: resumeId, userId, isMaster: true, content: parsedResume.text, fileName: parsedResume.metadata.fileName, mimeType: 'text/plain', parsedData: { sections: parsedResume.sections, metadata: parsedResume.metadata } as unknown as Prisma.InputJsonValue } });
    await prisma.resumeSourceFact.create({ data: {
      id: e2eApprovedFactId, userId, resumeId, factType: 'SKILL', value: { skill: 'TypeScript' },
      sourceText: 'TypeScript', sourceStart: 0, sourceEnd: 10, checksum: 'f'.repeat(64),
      approved: true, approvedAt: new Date(), approvedBy: userId,
    } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, jobId, content: 'Approved fixture facts.', atsScoreData: { version: 'fixture' }, sourceFacts: [{ sourceFactId: e2eApprovedFactId, sourceChecksum: 'f'.repeat(64) }] } });
    // One instant shared by the stored object and its recorded preflight evidence: the
    // submission preflight compares approval metadata between the two byte-for-byte.
    const resumeApprovedAt = new Date();
    await prisma.objectMetadata.create({ data: { id: providerObjectId, userId, resumeVersionId: versionId, bucket: 'private-documents', objectKey: `private/resume_approved/${userId}/${'a'.repeat(64)}`, kind: 'RESUME_APPROVED', fileName: 'approved-resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(16), checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: resumeApprovedAt, approvedBy: userId } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId: browserJobId, resumeVersionId: versionId, status: 'UNCONFIRMED', appliedAt: new Date(Date.now() - 2_000) } });
    await prisma.application.create({ data: { id: verificationApplicationId, userId, jobId: verificationJobId, resumeVersionId: versionId, status: 'APPLICATION_STARTED' } });
    await prisma.application.create({ data: { id: providerApplicationId, userId, jobId: providerJobId, resumeVersionId: versionId, status: 'SUBMISSION_PENDING' } });
    await prisma.submissionAuthorization.create({ data: { id: providerAuthorizationId, userId, applicationId: providerApplicationId, applicationVersion: 0, resumeVersionId: versionId, status: 'EXECUTING', expiresAt: new Date(Date.now() + 60 * 60 * 1000), idempotencyKey: 'e2e-provider-authorization', correlationId: 'e2e-provider' , preflightEvidence: { resumeVersionId: versionId, resumeDocument: { id: providerObjectId, kind: 'RESUME_APPROVED', bucket: 'private-documents', objectKey: `private/resume_approved/${userId}/${'a'.repeat(64)}`, versionId: null, fileName: 'approved-resume.pdf', mimeType: 'application/pdf', byteSize: '16', checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: resumeApprovedAt.toISOString(), approvedBy: userId }, coverLetterDocument: null } } });
    await prisma.applicationAttempt.create({ data: { applicationId, attemptNumber: 1, status: 'UNCONFIRMED', startedAt: new Date(Date.now() - 2_000), completedAt: new Date(Date.now() - 1_000), logs: [] } });
    process.env.JWT_SECRET ??= 'fixture-jwt-secret-for-integration-only-0123456789';
    const app = createApp();
    apiServer = app.listen(0);
    await new Promise<void>(resolve => apiServer.once('listening', resolve));
    const address = apiServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture API did not expose a TCP address');
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: executable() });
  });

  afterAll(async () => {
    await browser?.close();
    if (apiServer) await new Promise<void>((resolve, reject) => apiServer.close(error => error ? reject(error) : resolve()));
    await prisma.user.delete({ where: { id: userId } });
    await prisma.job.delete({ where: { id: jobId } });
    await prisma.job.delete({ where: { id: browserJobId } });
    await prisma.job.delete({ where: { id: verificationJobId } });
    await prisma.job.delete({ where: { id: providerJobId } });
    await prisma.$disconnect();
  });

  it('connects real browser form interaction to durable independent verification', async () => {
    const [discoveryRun] = await createDiscoveryRuns(userId, { greenhouseBoards: ['fixture'], leverCompanies: [], ashbyBoards: [] }, `e2e-discovery:${userId}`);
    const discovered = await executeDiscoveryRun(userId, discoveryRun.id, {
      discover: async () => ({ jobs: [{
        source: 'greenhouse', sourceJobId, company: 'Fixture', title: 'Engineer', location: 'Remote',
        description: 'Fixture discovery posting', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/1', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/1',
        fingerprint: createHash('sha256').update(`GREENHOUSE:${sourceJobId}`).digest('hex'),
        provenance: { source: 'greenhouse', tenant: userId, sourceJobId, fetchedAt: new Date().toISOString(), apiUrl: 'https://boards.greenhouse.io/fixture/api/1' },
      }], page: { pageSize: 1, returned: 1, hasMore: false } }),
    });
    expect(discovered.status).toBe('SUCCEEDED');
    const analysisJobs = await prisma.automationJob.findMany({ where: { userId, type: 'ANALYZE_JOB' }, select: { payload: true } });
    expect(analysisJobs.some(automationJob => (automationJob.payload as { jobId?: string }).jobId === jobId)).toBe(true);
    const analysis = {
      summary: 'A reliable TypeScript engineering role.', mustHave: ['TypeScript'], niceToHave: [],
      potentiallyOptional: [], technologyStack: ['TypeScript'], hiddenSignals: [], leadershipExpected: false,
      communicationLevel: 'High', domainExperience: '', teamSize: '', methodologies: [], benefits: [], redFlags: [],
    };
    analyze.mockResolvedValueOnce({
      kind: 'jd-analysis' as const,
      versions: { schema: 'jd-analysis/1.0.0' as const, prompt: 'jd-analysis-prompt/1.0.0', provider: { name: 'fixture-provider', version: '1.0.0' }, model: { name: 'fixture-model', version: '2026-09-10' } },
      contentHashes: { algorithm: 'sha256' as const, input: 'e'.repeat(64), output: 'd'.repeat(64) },
      trustBoundary: { input: { classification: 'untrusted-external-content' as const, source: 'https://boards.greenhouse.io/fixture/jobs/1', instructionsMustBeIgnored: true as const }, output: { classification: 'model-generated-untrusted-content' as const, runtimeValidated: true as const, safeForAutomaticAction: false as const } },
      metadata: { confidence: { overall: 0.9, fields: Object.fromEntries(Object.keys(analysis).map(key => [key, 0.9])) }, tokens: { input: 20, output: 20, total: 40 }, cost: { amount: 0, currency: 'USD', estimated: true } },
      analysis,
    });
    const handlers = createProductionAutomationJobHandlers();
    const invoke = async (type: string, job: { id: string; payload: unknown }) => handlers.get(type)!( {
      automationJobId: job.id, userId, type, payload: job.payload as never, payloadVersion: 1,
      correlationId: `e2e-${type}`, deliveryGeneration: 1, attempt: 1, workerId: 'e2e-pipeline',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    });
    const analysisJob = (await prisma.automationJob.findMany({ where: { userId, type: 'ANALYZE_JOB' } })).find(job => (job.payload as { jobId?: string }).jobId === jobId);
    expect(analysisJob).toBeDefined();
    await invoke('ANALYZE_JOB', analysisJob!);
    const matchJob = await prisma.automationJob.findFirstOrThrow({ where: { userId, type: 'MATCH_JOB', payload: { path: ['jobId'], equals: jobId } } });
    await invoke('MATCH_JOB', matchJob);
    await expect(prisma.jobMatch.findUniqueOrThrow({ where: { jobId_userId: { jobId, userId } } })).resolves.toMatchObject({ jobId, userId });
    const tailorJob = await prisma.automationJob.findFirstOrThrow({ where: { userId, type: 'TAILOR_RESUME', payload: { path: ['jobId'], equals: jobId } } });
    await invoke('TAILOR_RESUME', tailorJob);
    const tailored = await prisma.resumeVersion.findFirstOrThrow({ where: { resumeId, jobId }, orderBy: { generatedAt: 'desc' } });
    expect(tailored.sourceFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFactId: e2eApprovedFactId, sourceChecksum: 'f'.repeat(64) }),
    ]));
    const atsJob = await prisma.automationJob.findFirstOrThrow({ where: { userId, type: 'EVALUATE_ATS', payload: { path: ['resumeVersionId'], equals: tailored.id } } });
    await invoke('EVALUATE_ATS', atsJob);
    const pipelineApplication = await prisma.application.findFirstOrThrow({ where: { userId, jobId, resumeVersionId: tailored.id } });
    expect(pipelineApplication.status).toBe('DISCOVERED');
    const qualityJob = await prisma.automationJob.findFirstOrThrow({ where: { userId, type: 'EVALUATE_APPLICATION_QUALITY', applicationId: pipelineApplication.id } });
    await invoke('EVALUATE_APPLICATION_QUALITY', qualityJob);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: pipelineApplication.id } })).resolves.toMatchObject({ status: 'QUALIFIED' });
    await prisma.objectMetadata.create({ data: {
      id: tailoredObjectId, userId, resumeVersionId: tailored.id, bucket: 'private-documents',
      objectKey: `private/resume_tailored/${userId}/${'b'.repeat(64)}`, kind: 'RESUME_TAILORED',
      fileName: 'tailored-resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(16),
      checksumSha256: 'b'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN',
      approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId,
    } });
    const prepared = await prepareApplicationForForm({
      userId, applicationId: pipelineApplication.id, idempotencyKey: 'e2e-pipeline-form', correlationId: 'e2e-pipeline-form',
    });
    expect(prepared.automationJob.type).toBe('COMPLETE_GREENHOUSE_APPLICATION');
    await expect(prisma.application.findUniqueOrThrow({ where: { id: pipelineApplication.id } })).resolves.toMatchObject({ status: 'APPLICATION_STARTED' });
    const providerContext = await browser.newContext();
    try {
      const providerPage = await providerContext.newPage();
      await providerPage.setContent('<form><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file"></form>');
      const providerSessions = {
        start: async () => ({ session: { externalRef: 'e2e-pipeline-form-session' }, replayed: false }),
        withPage: async (_owner: string, _reference: string, operation: (current: import('playwright').Page) => Promise<unknown>) => operation(providerPage),
        close: async () => undefined,
      };
      const providerStorage = { readAuthorized: async () => ({ buffer: Buffer.from('%PDF-1.7 fixture'), fileName: 'tailored-resume.pdf', mimeType: 'application/pdf' as const }) };
      const providerService = new GreenhouseApplicationService(providerSessions as never, current => new GreenhousePlaywrightFormPort(current) as never, providerStorage as never);
      const providerHandler = createProductionAutomationJobHandlers({ greenhouseApplication: providerService }).get('COMPLETE_GREENHOUSE_APPLICATION');
      expect(providerHandler).toBeDefined();
      await providerHandler!({
        automationJobId: prepared.automationJob.id, userId, type: prepared.automationJob.type, payload: prepared.automationJob.payload,
        payloadVersion: prepared.automationJob.payloadVersion, correlationId: 'e2e-provider-form', deliveryGeneration: prepared.automationJob.deliveryGeneration,
        attempt: 1, workerId: 'e2e-provider-form', signal: new AbortController().signal, heartbeat: async () => undefined,
      });
      await expect(prisma.application.findUniqueOrThrow({ where: { id: pipelineApplication.id } })).resolves.toMatchObject({ status: 'FORM_FILLED' });
    } finally {
      await providerContext.close();
    }
    const pipelineVersion = await prisma.application.findUniqueOrThrow({ where: { id: pipelineApplication.id }, select: { version: true } });
    const ready = await withTenant(userId, tx => transitionApplicationInTenant(tx, {
      applicationId: pipelineApplication.id, userId, toStatus: 'READY_TO_SUBMIT', expectedVersion: pipelineVersion.version,
      actorType: 'USER', actorId: userId, reason: 'Fixture user explicitly approved the prepared application', idempotencyKey: 'e2e-ready-to-submit', correlationId: 'e2e-ready-to-submit',
    }));
    const authorization = await authorizeSubmission({ userId, applicationId: pipelineApplication.id, expectedVersion: ready.application.version, idempotencyKey: 'e2e-pipeline-authorization', correlationId: 'e2e-pipeline-authorization' });
    const submitContext = await browser.newContext();
    try {
      const submitPage = await submitContext.newPage();
      await submitPage.setContent('<form><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file"><button id="submit" type="submit">Submit</button></form>');
      await submitPage.locator('#submit').evaluate(button => button.addEventListener('click', event => { event.preventDefault(); document.body.innerHTML = '<p>Application received. Application ID: gh-pipeline-3456</p>'; }));
      const submitSessions = {
        start: async () => ({ session: { externalRef: 'e2e-pipeline-submit-session' }, replayed: false }),
        withPage: async (_owner: string, _reference: string, operation: (current: import('playwright').Page) => Promise<unknown>) => operation(submitPage),
        close: async () => undefined,
      };
      const submitStorage = { readAuthorized: async () => ({ buffer: Buffer.from('%PDF-1.7 fixture'), fileName: 'tailored-resume.pdf', mimeType: 'application/pdf' as const }) };
      const submissionService = new ProviderSubmissionService(submitSessions as never, submitStorage as never, { GREENHOUSE: current => new GreenhousePlaywrightFormPort(current) as never, LEVER: current => new GreenhousePlaywrightFormPort(current) as never });
      const attempted = await executeAuthorizedSubmission({ userId, authorizationId: authorization.authorization.id, correlationId: 'e2e-pipeline-submit', workerId: 'e2e-pipeline-submit' }, submissionService);
      if (attempted.replayed) throw new Error('Pipeline authorization unexpectedly replayed');
      expect(attempted.application.status).toBe('UNCONFIRMED');
      const verificationJob = await prisma.automationJob.findFirstOrThrow({ where: { applicationId: pipelineApplication.id, type: 'VERIFY_SUBMISSION_CONFIRMATION' } });
      const verifyHandler = createProductionAutomationJobHandlers().get('VERIFY_SUBMISSION_CONFIRMATION');
      expect(verifyHandler).toBeDefined();
      await verifyHandler!({ automationJobId: verificationJob.id, userId, type: verificationJob.type, payload: verificationJob.payload, payloadVersion: verificationJob.payloadVersion, correlationId: 'e2e-pipeline-verify', deliveryGeneration: verificationJob.deliveryGeneration, attempt: 1, workerId: 'e2e-pipeline-verifier', signal: new AbortController().signal, heartbeat: async () => undefined });
      await expect(prisma.application.findUniqueOrThrow({ where: { id: pipelineApplication.id } })).resolves.toMatchObject({ status: 'CONFIRMED' });
    } finally {
      await submitContext.close();
    }
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent('<form><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" required><button id="submit" type="button">Submit</button></form>');
      await page.locator('#submit').evaluate(button => button.addEventListener('click', () => { document.body.innerHTML = '<h1>Thanks for applying</h1><p>Application received. Application ID: gh-e2e-1234</p>'; }));
      const port = new GreenhousePlaywrightFormPort(page);
      const filled = await new GreenhouseApplicationAdapter().fillCurrentStep(port, { email: 'ada@example.invalid' });
      expect(filled.filledFieldIds).toEqual(['email']);
      await port.uploadDocument('resume', { fileName: 'approved-resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), bytes: Buffer.from('%PDF-1.7 fixture') });
      await page.locator('#submit').click();
      const verification = await verifyProviderConfirmation({ userId, applicationId, correlationId: 'e2e-fixture', provider: 'GREENHOUSE', pageText: await page.locator('body').innerText(), observedAt: new Date() });
      expect(verification.application.status).toBe('CONFIRMED');
      expect(verification.evidence).toBeDefined();
      expect(verification.evidence?.confirmationId).toBe('gh-e2e-1234');
      await expect(prisma.submissionVerificationEvidence.count({ where: { applicationId } })).resolves.toBe(1);
      await expect(prisma.applicationAttempt.findFirstOrThrow({ where: { applicationId } })).resolves.toMatchObject({ status: 'CONFIRMED' });
      const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { userId, aggregateType: 'Application', aggregateId: applicationId, eventType: 'application.status.transitioned', payload: { path: ['toStatus'], equals: 'CONFIRMED' } } });
      const notification = await consumeNotificationOutboxEvent({ ...outbox, userId: outbox.userId!, payload: outbox.payload, publishAttempts: outbox.publishAttempts } as OutboxEnvelope);
      expect(notification).toMatchObject({ responseCode: 201, responseBody: { consumed: true } });
      await expect(prisma.notification.findFirstOrThrow({ where: { userId, type: 'APPLICATION_SUBMITTED' } })).resolves.toMatchObject({ title: 'Application confirmed' });
      const authorization = { authorization: `Bearer ${generateToken({ userId, email: `${userId}@example.invalid` })}` };
      const [jobsResponse, applicationsResponse, analyticsResponse, notificationsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/jobs`, { headers: authorization }),
        fetch(`${apiBaseUrl}/api/applications`, { headers: authorization }),
        fetch(`${apiBaseUrl}/api/analytics/dashboard`, { headers: authorization }),
        fetch(`${apiBaseUrl}/api/notifications`, { headers: authorization }),
      ]);
      expect(jobsResponse.status).toBe(200);
      expect(applicationsResponse.status).toBe(200);
      expect(analyticsResponse.status).toBe(200);
      expect(notificationsResponse.status).toBe(200);
      const jobs = await jobsResponse.json();
      expect(jobs).toMatchObject({ success: true, data: expect.arrayContaining([expect.objectContaining({ id: jobId, matches: expect.arrayContaining([expect.objectContaining({ userId })]) })]) });
      expect(await applicationsResponse.json()).toMatchObject({ success: true, data: expect.arrayContaining([expect.objectContaining({ id: applicationId, status: 'CONFIRMED' })]) });
      const analytics = await analyticsResponse.json();
      expect(analytics).toMatchObject({ success: true });
      expect(analytics.data.submissionSuccessRate).toBeCloseTo(100 / 2, 10);
      expect(await notificationsResponse.json()).toMatchObject({ success: true, data: expect.arrayContaining([expect.objectContaining({ type: 'APPLICATION_SUBMITTED' })]) });
    } finally {
      await context.close();
    }
  }, 30_000);

  it('executes the authorized provider service through a real Chromium submit flow', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent('<form><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" required><button id="submit" type="submit">Submit</button></form>');
      await page.locator('#submit').evaluate(button => button.addEventListener('click', event => { event.preventDefault(); globalThis.document.body.innerHTML = '<h1>Thanks for applying</h1><p>Application received. Application ID: gh-provider-5678</p>'; }));
      const sessions = {
        start: async () => ({ session: { externalRef: 'e2e-provider-session' }, replayed: false }),
        withPage: async (_owner: string, _reference: string, operation: (current: import('playwright').Page) => Promise<unknown>) => operation(page),
        close: async () => undefined,
      };
      const storage = { readAuthorized: async () => ({ buffer: Buffer.from('%PDF-1.7 fixture'), fileName: 'approved-resume.pdf', mimeType: 'application/pdf' as const }) };
      const service = new ProviderSubmissionService(sessions as never, storage as never, { GREENHOUSE: current => new GreenhousePlaywrightFormPort(current) as never, LEVER: current => new GreenhousePlaywrightFormPort(current) as never });
      const result = await service.execute({ userId, applicationId: providerApplicationId, authorizationId: providerAuthorizationId, correlationId: 'e2e-provider', workerId: 'e2e-provider-worker' });
      expect(result.provider).toBe('GREENHOUSE');
      expect(result.confirmation).toMatchObject({ confirmationId: 'gh-provider-5678', source: 'CONFIRMATION_PAGE' });
      await expect(prisma.submissionAuthorization.findUniqueOrThrow({ where: { id: providerAuthorizationId } })).resolves.toMatchObject({ status: 'EXECUTING' });

      await prisma.submissionAuthorization.update({ where: { id: providerAuthorizationId }, data: { status: 'AUTHORIZED' } });
      const engineContext = await browser.newContext();
      try {
        const enginePage = await engineContext.newPage();
        await enginePage.setContent('<form><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" required><button id="submit" type="submit">Submit</button></form>');
        await enginePage.locator('#submit').evaluate(button => button.addEventListener('click', event => { event.preventDefault(); globalThis.document.body.innerHTML = '<p>Application received. Application ID: gh-engine-9012</p>'; }));
        const engineSessions = {
          start: async () => ({ session: { externalRef: 'e2e-engine-session' }, replayed: false }),
          withPage: async (_owner: string, _reference: string, operation: (current: import('playwright').Page) => Promise<unknown>) => operation(enginePage),
          close: async () => undefined,
        };
        const engineStorage = { readAuthorized: async () => ({ buffer: Buffer.from('%PDF-1.7 fixture'), fileName: 'approved-resume.pdf', mimeType: 'application/pdf' as const }) };
        const engineService = new ProviderSubmissionService(engineSessions as never, engineStorage as never, { GREENHOUSE: current => new GreenhousePlaywrightFormPort(current) as never, LEVER: current => new GreenhousePlaywrightFormPort(current) as never });
        const attempted = await executeAuthorizedSubmission({ userId, authorizationId: providerAuthorizationId, correlationId: 'e2e-provider-engine', workerId: 'e2e-provider-worker' }, engineService);
        expect(attempted.replayed).toBe(false);
        if (attempted.replayed) throw new Error('Provider certification unexpectedly replayed the authorization');
        expect(attempted.application.status).toBe('UNCONFIRMED');
        expect(attempted.authorization.status).toBe('CONSUMED');
        const verificationJob = await prisma.automationJob.findFirstOrThrow({ where: { applicationId: providerApplicationId, type: 'VERIFY_SUBMISSION_CONFIRMATION' } });
        const evidence = verificationJob.payload as { applicationId: string; provider: 'GREENHOUSE'; confirmationId: string; evidenceHash: string; parserVersion: string; observedAt: string; source: 'CONFIRMATION_PAGE' };
        expect(evidence.confirmationId).toBe('gh-engine-9012');
        const verifyHandler = createProductionAutomationJobHandlers().get('VERIFY_SUBMISSION_CONFIRMATION');
        expect(verifyHandler).toBeDefined();
        await verifyHandler!({ automationJobId: verificationJob.id, userId, type: verificationJob.type, payload: verificationJob.payload, payloadVersion: verificationJob.payloadVersion, correlationId: 'e2e-provider-verify', deliveryGeneration: verificationJob.deliveryGeneration, attempt: 1, workerId: 'e2e-provider-verifier', signal: new AbortController().signal, heartbeat: async () => undefined });
        await expect(prisma.application.findUniqueOrThrow({ where: { id: providerApplicationId } })).resolves.toMatchObject({ status: 'CONFIRMED' });
        await expect(prisma.applicationAttempt.findFirstOrThrow({ where: { applicationId: providerApplicationId } })).resolves.toMatchObject({ status: 'CONFIRMED' });
      } finally {
        await engineContext.close();
      }
    } finally {
      await context.close();
    }
  }, 30_000);

  it('pauses a real CAPTCHA page into durable human verification', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent('<form><label for="captcha">Security check</label><input id="captcha" name="g-recaptcha-response" required></form>');
      const sessions = {
        start: async () => ({ session: { externalRef: 'e2e-verification-session' }, replayed: false }),
        withPage: async (_owner: string, _reference: string, operation: (current: import('playwright').Page) => Promise<unknown>) => operation(page),
        close: async () => undefined,
      };
      const service = new GreenhouseApplicationService(sessions as never, current => new GreenhousePlaywrightFormPort(current) as never);
      await expect(service.execute({ userId, applicationId: verificationApplicationId, workerId: 'e2e-worker', correlationId: 'e2e-captcha', idempotencyKey: 'e2e-captcha' }))
        .resolves.toEqual({ outcome: 'HUMAN_VERIFICATION_REQUIRED' });
      await expect(prisma.application.findUniqueOrThrow({ where: { id: verificationApplicationId } })).resolves.toMatchObject({ status: 'WAITING_FOR_USER' });
      const verification = await prisma.humanVerification.findFirstOrThrow({ where: { applicationId: verificationApplicationId } });
      verificationId = verification.id;
      expect(verification).toMatchObject({ type: 'CAPTCHA', status: 'PENDING' });
    } finally {
      await context.close();
    }
  }, 30_000);

  it('resumes only at the recorded safe checkpoint after explicit human acknowledgement', async () => {
    const resolved = await resolveHumanVerification({ userId, verificationId, correlationId: 'e2e-human-resolve' });
    expect(resolved.verification.status).toBe('RESOLVED');
    expect(resolved.resumeJob.type).toBe('RESUME_APPLICATION_AFTER_VERIFICATION');
    const resumed = await resumeHumanVerification(userId, verificationId, 'e2e-human-resume');
    expect(resumed).toMatchObject({ resumed: true });
    await expect(prisma.application.findUniqueOrThrow({ where: { id: verificationApplicationId } })).resolves.toMatchObject({ status: 'FORM_FILLED' });
    await expect(resolveHumanVerification({ userId, verificationId, correlationId: 'e2e-human-resolve' })).resolves.toMatchObject({ replayed: true });
  }, 30_000);
});
