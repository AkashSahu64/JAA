import { Prisma } from '@prisma/client';
import { JobAnalysisAgent } from '@jobagent/ai';
import { prisma } from '@jobagent/database';
import type { AutomationJobHandler, AutomationJobHandlerContext } from './automation-worker';
import { executeDiscoveryRun } from './job-discovery';
import { executeJobMatch } from './job-matching';
import { executeResumeTailoring } from './resume-tailoring';
import { executeATSEvaluation } from './ats-evaluation';
import { executeApplicationQuality } from './application-quality';
import { resumeHumanVerification } from './human-verification';
import { GreenhouseApplicationService } from './greenhouse-application';
import { LeverApplicationService } from './lever-application';
import { AutomationJobRetryError } from './automation-jobs';
import { recordAuthorizedSubmissionHandoff } from './submission-engine';

export type AutomationJobHandlerMap = ReadonlyMap<string, AutomationJobHandler>;

function payloadObject(context: AutomationJobHandlerContext): Record<string, Prisma.JsonValue> {
  if (typeof context.payload !== 'object' || context.payload === null || Array.isArray(context.payload)) {
    throw new Error(`${context.type} payload must be an object`);
  }
  return context.payload as Record<string, Prisma.JsonValue>;
}

function requiredText(payload: Record<string, Prisma.JsonValue>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
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
  await executeResumeTailoring(context.userId, resumeId, jobId);
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function evaluateATS(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const resumeVersionId = requiredText(payload, 'resumeVersionId');
  if (context.payloadVersion !== 1) throw new Error('EVALUATE_ATS payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await executeATSEvaluation(context.userId, resumeVersionId);
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

async function executeGreenhouseApplication(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  if (context.payloadVersion !== 1) throw new Error('COMPLETE_GREENHOUSE_APPLICATION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await new GreenhouseApplicationService().execute({
    userId: context.userId,
    applicationId,
    workerId: context.workerId,
    correlationId: context.correlationId,
    idempotencyKey: context.automationJobId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

async function executeLeverApplication(context: AutomationJobHandlerContext): Promise<void> {
  const payload = payloadObject(context);
  const applicationId = requiredText(payload, 'applicationId');
  if (context.payloadVersion !== 1) throw new Error('COMPLETE_LEVER_APPLICATION payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await new LeverApplicationService().execute({
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
  if (context.payloadVersion !== 1) throw new Error('RECORD_AUTHORIZED_SUBMISSION_HANDOFF payloadVersion must be 1');
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
  await recordAuthorizedSubmissionHandoff({
    userId: context.userId,
    authorizationId,
    correlationId: context.correlationId,
  });
  if (context.signal.aborted) throw abortError(context.signal);
  await context.heartbeat();
}

function discoveryHandler(runDiscovery: typeof executeDiscoveryRun): AutomationJobHandler {
  return async context => {
    const payload = payloadObject(context);
    const runId = requiredText(payload, 'runId');
    if (context.payloadVersion !== 1) throw new Error('DISCOVER_JOBS payloadVersion must be 1');
    if (context.signal.aborted) throw abortError(context.signal);
    await context.heartbeat();
    if (context.signal.aborted) throw abortError(context.signal);
    const result = await runDiscovery(context.userId, runId, undefined, context.signal, {
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
  dependencies: { executeDiscoveryRun?: typeof executeDiscoveryRun } = {},
): AutomationJobHandlerMap {
  return new Map<string, AutomationJobHandler>([
    ['ANALYZE_JOB', analyzeJob],
    ['MATCH_JOB', matchJob],
    ['TAILOR_RESUME', tailorResume],
    ['EVALUATE_ATS', evaluateATS],
    ['EVALUATE_APPLICATION_QUALITY', evaluateApplicationQuality],
    ['COMPLETE_GREENHOUSE_APPLICATION', executeGreenhouseApplication],
    ['COMPLETE_LEVER_APPLICATION', executeLeverApplication],
    ['RECORD_AUTHORIZED_SUBMISSION_HANDOFF', recordSubmissionHandoff],
    ['RESUME_APPLICATION_AFTER_VERIFICATION', resumeApplicationAfterVerification],
    ['DISCOVER_JOBS', discoveryHandler(dependencies.executeDiscoveryRun ?? executeDiscoveryRun)],
  ]);
}
