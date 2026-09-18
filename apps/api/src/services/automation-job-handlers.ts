import { Prisma } from '@prisma/client';
import { JobAnalysisAgent } from '@jobagent/ai';
import { prisma, withTenant } from '@jobagent/database';
import type { AutomationJobHandler, AutomationJobHandlerContext } from './automation-worker';
import { executeDiscoveryRun, type DiscoveryExecutor } from './job-discovery';
import { executeJobMatch } from './job-matching';
import { executeResumeTailoring } from './resume-tailoring';
import { executeATSEvaluation } from './ats-evaluation';
import { executeApplicationQuality } from './application-quality';
import { resumeHumanVerification } from './human-verification';
import { GreenhouseApplicationService } from './greenhouse-application';
import { LeverApplicationService } from './lever-application';
import { AutomationJobRetryError, createAutomationJob } from './automation-jobs';
import { recordAuthorizedSubmissionHandoff } from './submission-engine';
import { ingestEmailOutcome } from './email-outcomes';
import { syncEmailConnection } from './email-sync';
import { createMailboxConnector } from './email-connectors';
import { verifySubmission } from './submission-verification';
import { createApplicationIntent } from './application-creation';

export type AutomationJobHandlerMap = ReadonlyMap<string, AutomationJobHandler>;

function payloadObject(context: AutomationJobHandlerContext): Record<string, Prisma.JsonValue> {
  if (typeof context.payload !== 'object' || context.payload === null || Array.isArray(context.payload)) {
    throw new Error(`${context.type} payload must be an object`);
  }
  return context.payload as Record<string, Prisma.JsonValue>;
}

function requiredText(payload: Record<string, Prisma.JsonValue>, name: string, options: { allowControlCharacters?: boolean } = {}): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000
    || (!options.allowControlCharacters && Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new Error(`${name} is required and bounded`);
  }
  return value.trim();
}

async function analyzeJob(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const jobId = requiredText(payload, 'jobId');
  if (context.payloadVersion !== 1) throw new Error('ANALYZE_JOB payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, title: true, company: true, description: true, sourceUrl: true },
  });
  if (!job) throw new Error('Job not found');

  await context.heartbeat();
  const startedAt = performance.now();
  const envelope = await new JobAnalysisAgent().analyze(job.title, job.description, job.company, job.sourceUrl);
  const latencyMs = Math.round(performance.now() - startedAt);
  if (context.signal.aborted) throw abortError(context.signal);

  await prisma.jobAnalysis.upsert({
    where: { jobId: job.id },
    update: analysisPersistence(envelope, latencyMs),
    create: { jobId: job.id, ...analysisPersistence(envelope, latencyMs) },
  });
  // Analysis is a durable pipeline boundary. Queue the deterministic match
  // only after the validated analysis is persisted; the input hash keeps
  // retries and re-analysis of the same posting idempotent across runs.
  await createAutomationJob({
    userId: context.userId,
    type: 'MATCH_JOB',
    payload: { jobId: job.id },
    payloadVersion: 1,
    correlationId: `match:${job.id}:${envelope.contentHashes.input}`,
    idempotencyKey: `match-job:${context.userId}:${job.id}:${envelope.contentHashes.input}`,
    maxAttempts: 3,
  });
  await context.heartbeat();
}

function analysisPersistence(envelope: Awaited<ReturnType<JobAnalysisAgent['analyze']>>, latencyMs: number) {
  const { analysis, versions, contentHashes, metadata, trustBoundary } = envelope;
  return {
    ...analysis,
    analysisVersion: `${versions.schema}:${versions.prompt}`,
    schemaVersion: versions.schema,
    promptVersion: versions.prompt,
    providerName: versions.provider.name,
    providerVersion: versions.provider.version,
    modelName: versions.model.name,
    modelVersion: versions.model.version,
    inputHash: contentHashes.input,
    outputHash: contentHashes.output,
    latencyMs,
    inputTokens: metadata.tokens.input,
    outputTokens: metadata.tokens.output,
    totalTokens: metadata.tokens.total,
    costAmount: metadata.cost.amount,
    costCurrency: metadata.cost.currency,
    costEstimated: metadata.cost.estimated,
    confidence: metadata.confidence as unknown as Prisma.InputJsonValue,
    trustBoundary: trustBoundary as unknown as Prisma.InputJsonValue,
    analyzedAt: new Date(),
  };
}

async function matchJob(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const jobId = requiredText(payload, 'jobId');
  if (context.payloadVersion !== 1) throw new Error('MATCH_JOB payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await executeJobMatch(context.userId, jobId);
  const master = await withTenant(context.userId, tx => tx.resume.findFirst({
    where: { userId: context.userId, isMaster: true, sourceFacts: { some: { approved: true } } },
    select: { id: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  }));
  if (master) {
    // Tailoring is safe to automate only when the candidate has an approved
    // source of truth. The tailoring service re-checks the facts before its
    // model call and persists only cited claims.
    await createAutomationJob({
      userId: context.userId,
      type: 'TAILOR_RESUME',
      payload: { resumeId: master.id, jobId },
      payloadVersion: 1,
      correlationId: `tailor:${master.id}:${jobId}`,
      idempotencyKey: `tailor-resume:${context.userId}:${master.id}:${jobId}`,
      maxAttempts: 3,
    });
  }
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function tailorResume(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const resumeId = requiredText(payload, 'resumeId');
  const jobId = requiredText(payload, 'jobId');
  if (context.payloadVersion !== 1) throw new Error('TAILOR_RESUME payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  const version = await executeResumeTailoring(context.userId, resumeId, jobId);
  await createAutomationJob({
    userId: context.userId,
    type: 'EVALUATE_ATS',
    payload: { resumeVersionId: version.id },
    payloadVersion: 1,
    correlationId: `ats:${version.id}`,
    idempotencyKey: `evaluate-ats:${context.userId}:${version.id}`,
    maxAttempts: 3,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function evaluateATS(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const resumeVersionId = requiredText(payload, 'resumeVersionId');
  if (context.payloadVersion !== 1) throw new Error('EVALUATE_ATS payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  const version = await executeATSEvaluation(context.userId, resumeVersionId);
  const profiles = await withTenant(context.userId, tx => tx.searchProfile.findMany({
    where: { userId: context.userId, isActive: true },
    select: { id: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  }));
  if (profiles.length === 1 && version.jobId) {
    await createApplicationIntent({
      userId: context.userId,
      jobId: version.jobId,
      resumeVersionId: version.id,
      searchProfileId: profiles[0].id,
      correlationId: `application:${version.id}:${profiles[0].id}`,
      idempotencyKey: `application:${context.userId}:${version.id}:${profiles[0].id}`,
    });
  }
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function evaluateApplicationQuality(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  const searchProfileId = requiredText(payload, 'searchProfileId');
  if (context.payloadVersion !== 1) throw new Error('EVALUATE_APPLICATION_QUALITY payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await executeApplicationQuality({ userId: context.userId, applicationId, searchProfileId });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function resumeApplicationAfterVerification(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const verificationId = requiredText(payload, 'verificationId');
  if (context.payloadVersion !== 1) throw new Error('RESUME_APPLICATION_AFTER_VERIFICATION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await resumeHumanVerification(context.userId, verificationId, context.correlationId);
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

type ProviderApplicationExecutor = Pick<GreenhouseApplicationService, 'execute'> | Pick<LeverApplicationService, 'execute'>;

async function executeGreenhouseApplication(context: AutomationJobHandlerContext, executor: Pick<GreenhouseApplicationService, 'execute'> = new GreenhouseApplicationService()): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  if (context.payloadVersion !== 1) throw new Error('COMPLETE_GREENHOUSE_APPLICATION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await executor.execute({
    userId: context.userId,
    applicationId,
    workerId: context.workerId,
    correlationId: context.correlationId,
    idempotencyKey: context.automationJobId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function executeLeverApplication(context: AutomationJobHandlerContext, executor: Pick<LeverApplicationService, 'execute'> = new LeverApplicationService()): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  if (context.payloadVersion !== 1) throw new Error('COMPLETE_LEVER_APPLICATION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await executor.execute({
    userId: context.userId,
    applicationId,
    workerId: context.workerId,
    correlationId: context.correlationId,
    idempotencyKey: context.automationJobId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function recordSubmissionHandoff(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const authorizationId = requiredText(payload, 'authorizationId');
  if (context.payloadVersion !== 1) throw new Error('EXECUTE_AUTHORIZED_SUBMISSION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await recordAuthorizedSubmissionHandoff({
    userId: context.userId,
    authorizationId,
    correlationId: context.correlationId,
    workerId: context.workerId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function ingestEmailOutcomeJob(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  if (context.payloadVersion !== 1) throw new Error('EMAIL_OUTCOME payloadVersion must be 1');
  const receivedAtValue = requiredText(payload, 'receivedAt');
  const receivedAt = new Date(receivedAtValue);
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('receivedAt is invalid');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await ingestEmailOutcome({
    userId: context.userId,
    source: typeof payload.source === 'string' && payload.source.trim() ? payload.source.trim() : 'AUTOMATION',
    messageId: requiredText(payload, 'messageId'),
    sender: requiredText(payload, 'sender'),
    subject: requiredText(payload, 'subject'),
    body: requiredText(payload, 'body', { allowControlCharacters: true }),
    receivedAt,
    applicationId: typeof payload.applicationId === 'string' ? payload.applicationId.trim() || undefined : undefined,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function syncEmailConnectionJob(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const connectionId = requiredText(payload, 'connectionId');
  const provider = requiredText(payload, 'provider');
  if (context.payloadVersion !== 1) throw new Error('SYNC_EMAIL_CONNECTION payloadVersion must be 1');
  if (provider !== 'GMAIL' && provider !== 'MICROSOFT_GRAPH') throw new Error('provider is invalid');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await syncEmailConnection({
    userId: context.userId,
    connectionId,
    connector: createMailboxConnector({ userId: context.userId, provider }),
    correlationId: context.correlationId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function verifySubmissionConfirmationJob(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  const provider = requiredText(payload, 'provider');
  const confirmationId = requiredText(payload, 'confirmationId');
  const evidenceHash = requiredText(payload, 'evidenceHash');
  const parserVersion = requiredText(payload, 'parserVersion');
  const source = requiredText(payload, 'source');
  const attemptId = payload.attemptId === undefined ? undefined : requiredText(payload, 'attemptId');
  const observedAtValue = requiredText(payload, 'observedAt');
  if (context.payloadVersion !== 1) throw new Error('VERIFY_SUBMISSION_CONFIRMATION payloadVersion must be 1');
  if (provider !== 'GREENHOUSE' && provider !== 'LEVER') throw new Error('provider is invalid');
  if (!['CONFIRMATION_PAGE', 'PROVIDER_RESPONSE', 'APPLICATION_ID'].includes(source)) throw new Error('source is invalid');
  const observedAt = new Date(observedAtValue);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('observedAt is invalid');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await verifySubmission({
    userId: context.userId,
    applicationId,
    correlationId: context.correlationId,
    trustedBoundary: true,
    evidence: { applicationId, attemptId, provider, confirmationId, evidenceHash, parserVersion, observedAt, source } as Parameters<typeof verifySubmission>[0]['evidence'],
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

function discoveryHandler(runDiscovery: typeof executeDiscoveryRun, discoveryExecutor?: DiscoveryExecutor): AutomationJobHandler {
  return async context => {
    const payload = payloadObject(context);
    const runId = requiredText(payload, 'runId');
    if (context.payloadVersion !== 1) throw new Error('DISCOVER_JOBS payloadVersion must be 1');
    if (context.signal.aborted) throw abortError(context.signal);
    await context.heartbeat();
    if (context.signal.aborted) throw abortError(context.signal);
    const result = await runDiscovery(context.userId, runId, discoveryExecutor, context.signal, {
      automationJobId: context.automationJobId,
      workerId: context.workerId,
      deliveryGeneration: context.deliveryGeneration,
      dispatchAttempt: context.attempt,
    });
    if (result.status === 'CANCELLED' && context.signal.aborted) throw abortError(context.signal);
    if (result.errorRetryable === true && (result.status === 'FAILED' || result.status === 'PARTIAL')) {
      throw new AutomationJobRetryError(
        result.errorMessage ?? `Retryable discovery run ${runId} did not complete`,
        result.errorRetryAfterMs,
      );
    }
    await context.heartbeat();
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('DISCOVER_JOBS was aborted');
}

export function createProductionAutomationJobHandlers(
  dependencies: {
    executeDiscoveryRun?: typeof executeDiscoveryRun;
    discoveryExecutor?: DiscoveryExecutor;
    greenhouseApplication?: Pick<GreenhouseApplicationService, 'execute'>;
    leverApplication?: Pick<LeverApplicationService, 'execute'>;
  } = {},
): AutomationJobHandlerMap {
  return new Map<string, AutomationJobHandler>([
    ['ANALYZE_JOB', analyzeJob],
    ['MATCH_JOB', matchJob],
    ['TAILOR_RESUME', tailorResume],
    ['EVALUATE_ATS', evaluateATS],
    ['EVALUATE_APPLICATION_QUALITY', evaluateApplicationQuality],
    ['COMPLETE_GREENHOUSE_APPLICATION', context => executeGreenhouseApplication(context, dependencies.greenhouseApplication)],
    ['COMPLETE_LEVER_APPLICATION', context => executeLeverApplication(context, dependencies.leverApplication)],
    ['EXECUTE_AUTHORIZED_SUBMISSION', recordSubmissionHandoff],
    ['EMAIL_OUTCOME', ingestEmailOutcomeJob],
    ['SYNC_EMAIL_CONNECTION', syncEmailConnectionJob],
    ['VERIFY_SUBMISSION_CONFIRMATION', verifySubmissionConfirmationJob],
    ['RESUME_APPLICATION_AFTER_VERIFICATION', resumeApplicationAfterVerification],
    ['DISCOVER_JOBS', discoveryHandler(dependencies.executeDiscoveryRun ?? executeDiscoveryRun, dependencies.discoveryExecutor)],
  ]);
}
