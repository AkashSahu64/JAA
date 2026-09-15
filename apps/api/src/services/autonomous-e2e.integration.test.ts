import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { prisma } from '@jobagent/database';
import { generateToken } from '@jobagent/security';
import { GreenhouseApplicationAdapter } from '@jobagent/job-engine';
import { createApp } from '../app';
import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';
import { verifyProviderConfirmation } from './submission-verification';
import { consumeNotificationOutboxEvent } from './notification-outbox-consumer';
import type { OutboxEnvelope } from './outbox-publisher';
import { GreenhouseApplicationService } from './greenhouse-application';
import { resolveHumanVerification, resumeHumanVerification } from './human-verification';
import { ProviderSubmissionService } from './provider-submission';
import { executeAuthorizedSubmission } from './submission-engine';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';

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
  const resumeId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const verificationJobId = randomUUID();
  const providerJobId = randomUUID();
  const verificationApplicationId = randomUUID();
  const providerApplicationId = randomUUID();
  const providerAuthorizationId = randomUUID();
  const providerObjectId = randomUUID();
  let verificationId = '';
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let apiServer: ReturnType<ReturnType<typeof createApp>['listen']>;
  let apiBaseUrl = '';

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'E2E Fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/1', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/1' } });
    await prisma.job.create({ data: { id: verificationJobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Verification Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/2', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/2' } });
    await prisma.job.create({ data: { id: providerJobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Provider Engineer', description: 'Fixture', applicationUrl: 'https://boards.greenhouse.io/fixture/jobs/3', sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/3' } });
    await prisma.userProfile.create({ data: { userId, fullName: 'Ada Lovelace', email: 'ada@example.invalid' } });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'Approved fixture facts.' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, jobId, content: 'Approved fixture facts.', atsScoreData: { version: 'fixture' }, sourceFacts: [{ sourceFactId: randomUUID(), sourceChecksum: 'a'.repeat(64) }] } });
    await prisma.objectMetadata.create({ data: { id: providerObjectId, userId, resumeVersionId: versionId, bucket: 'private-documents', objectKey: `private/resume_approved/${userId}/${'a'.repeat(64)}`, kind: 'RESUME_APPROVED', fileName: 'approved-resume.pdf', mimeType: 'application/pdf', byteSize: BigInt(16), checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'UNCONFIRMED', appliedAt: new Date(Date.now() - 2_000) } });
    await prisma.application.create({ data: { id: verificationApplicationId, userId, jobId: verificationJobId, resumeVersionId: versionId, status: 'APPLICATION_STARTED' } });
    await prisma.application.create({ data: { id: providerApplicationId, userId, jobId: providerJobId, resumeVersionId: versionId, status: 'SUBMISSION_PENDING' } });
    await prisma.submissionAuthorization.create({ data: { id: providerAuthorizationId, userId, applicationId: providerApplicationId, applicationVersion: 0, resumeVersionId: versionId, status: 'EXECUTING', expiresAt: new Date(Date.now() + 60 * 60 * 1000), idempotencyKey: 'e2e-provider-authorization', correlationId: 'e2e-provider' , preflightEvidence: { resumeVersionId: versionId, resumeDocument: { id: providerObjectId, kind: 'RESUME_APPROVED', bucket: 'private-documents', objectKey: `private/resume_approved/${userId}/${'a'.repeat(64)}`, versionId: null, fileName: 'approved-resume.pdf', mimeType: 'application/pdf', byteSize: '16', checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN' }, coverLetterDocument: null } } });
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
    await prisma.job.delete({ where: { id: verificationJobId } });
    await prisma.job.delete({ where: { id: providerJobId } });
    await prisma.$disconnect();
  });

  it('connects real browser form interaction to durable independent verification', async () => {
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
      const [applicationsResponse, analyticsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/applications`, { headers: authorization }),
        fetch(`${apiBaseUrl}/api/analytics/dashboard`, { headers: authorization }),
      ]);
      expect(applicationsResponse.status).toBe(200);
      expect(analyticsResponse.status).toBe(200);
      expect(await applicationsResponse.json()).toMatchObject({ success: true, data: expect.arrayContaining([expect.objectContaining({ id: applicationId, status: 'CONFIRMED' })]) });
      const analytics = await analyticsResponse.json();
      expect(analytics).toMatchObject({ success: true });
      expect(analytics.data.submissionSuccessRate).toBeCloseTo(100 / 3, 10);
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
