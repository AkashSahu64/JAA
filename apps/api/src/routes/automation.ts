import { randomUUID } from 'node:crypto';
import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { parseLimit, validateBody } from '../middleware/validate';
import { cancelAutomationJob, replayDeadLetterAutomationJob } from '../services/automation-jobs';
import { collectApplicationQueueMetrics } from '../services/queue-metrics';
import { logRouteError } from '../observability/structured-log';
import { persistAutomationAlerts } from '../services/automation-alert-outbox';
import { normalizeCorrelationId } from '../middleware/request-logger';

const router = Router();
router.use(authenticate);

const AUTOMATION_MODES = new Set(['ASSISTED', 'SMART_AUTO', 'REVIEW_REQUIRED']);
const activeRunKey = (userId: string) => `active:${userId}`;

export function summarizeExecutionDurations(attempts: readonly { startedAt: Date; completedAt: Date | null }[]) {
  const durations = attempts
    .filter(attempt => attempt.startedAt instanceof Date && Number.isFinite(attempt.startedAt.getTime())
      && attempt.completedAt instanceof Date && Number.isFinite(attempt.completedAt.getTime()) && attempt.completedAt >= attempt.startedAt)
    .map(attempt => attempt.completedAt!.getTime() - attempt.startedAt.getTime());
  return {
    sampleCount: durations.length,
    averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    maxMs: durations.length ? Math.max(...durations) : 0,
  };
}

export function summarizePendingVerificationAges(records: readonly { createdAt: Date }[], now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { pendingCount: 0, oldestAgeMs: 0, averageAgeMs: 0, maxAgeMs: 0 };
  const ages = records.flatMap(record => {
    if (!(record?.createdAt instanceof Date) || !Number.isFinite(record.createdAt.getTime()) || record.createdAt > now) return [];
    return [Math.min(30 * 24 * 60 * 60 * 1_000, Math.max(0, now.getTime() - record.createdAt.getTime()))];
  });
  return {
    pendingCount: ages.length,
    oldestAgeMs: ages.length ? Math.max(...ages) : 0,
    averageAgeMs: ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : 0,
    maxAgeMs: ages.length ? Math.max(...ages) : 0,
  };
}

export interface AutomationOperationalAlert {
  code: 'QUEUE_METRICS_UNAVAILABLE' | 'QUEUE_BACKLOG' | 'QUEUE_FAILURES' | 'JOB_RETRIES' | 'HUMAN_VERIFICATION_AGING' | 'BROWSER_SESSIONS_ACTIVE';
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  value: number;
  threshold: number;
}

export function deriveAutomationAlerts(input: {
  queueMetrics: Array<{ waiting: number; oldestWaitingMs: number | null; failed: number }> | null;
  retryMetrics: { jobsWithRetries: number };
  browserSessions: Array<{ status: string; _count: { _all: number } }>;
  pendingVerification: { pendingCount: number; oldestAgeMs: number };
}): AutomationOperationalAlert[] {
  const alerts: AutomationOperationalAlert[] = [];
  if (input.queueMetrics === null) alerts.push({ code: 'QUEUE_METRICS_UNAVAILABLE', severity: 'WARNING', message: 'Transient queue metrics are unavailable; PostgreSQL-backed metrics remain available', value: 1, threshold: 1 });
  const waiting = input.queueMetrics?.reduce((sum, queue) => sum + queue.waiting, 0) ?? 0;
  const oldestWaitingMs = input.queueMetrics?.reduce<number | null>((oldest, queue) => oldest === null ? queue.oldestWaitingMs : queue.oldestWaitingMs === null ? oldest : Math.max(oldest, queue.oldestWaitingMs), null) ?? null;
  const failed = input.queueMetrics?.reduce((sum, queue) => sum + queue.failed, 0) ?? 0;
  if (waiting >= 100 || (oldestWaitingMs !== null && oldestWaitingMs >= 15 * 60 * 1_000)) alerts.push({ code: 'QUEUE_BACKLOG', severity: 'WARNING', message: 'Automation queue backlog requires operator attention', value: Math.max(waiting, Math.round((oldestWaitingMs ?? 0) / 1_000)), threshold: waiting >= 100 ? 100 : 15 * 60 });
  if (failed > 0) alerts.push({ code: 'QUEUE_FAILURES', severity: 'CRITICAL', message: 'Automation queue contains failed work', value: failed, threshold: 1 });
  if (input.retryMetrics.jobsWithRetries >= 10) alerts.push({ code: 'JOB_RETRIES', severity: 'WARNING', message: 'Many automation jobs have required retries', value: input.retryMetrics.jobsWithRetries, threshold: 10 });
  if (input.pendingVerification.oldestAgeMs >= 24 * 60 * 60 * 1_000) alerts.push({ code: 'HUMAN_VERIFICATION_AGING', severity: 'WARNING', message: 'Human verification has been waiting for more than 24 hours', value: Math.round(input.pendingVerification.oldestAgeMs / 1_000), threshold: 24 * 60 * 60 });
  const activeSessions = input.browserSessions.find(group => group.status === 'ACTIVE')?._count._all ?? 0;
  if (activeSessions >= 10) alerts.push({ code: 'BROWSER_SESSIONS_ACTIVE', severity: 'WARNING', message: 'Many browser sessions are active simultaneously', value: activeSessions, threshold: 10 });
  return alerts;
}

// GET /api/automation/status
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const run = await withTenant(req.user!.userId, tx => tx.automationRun.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { startedAt: 'desc' },
    }));
    return res.json({ success: true, data: run });
  } catch (error) {
    logRouteError('automation.status_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to get automation status' });
  }
});

// POST /api/automation/start
router.post('/start', validateBody({ mode: { type: 'string', maxLength: 32 } }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { mode = 'ASSISTED' } = req.body;
    if (!AUTOMATION_MODES.has(mode)) {
      return res.status(400).json({ success: false, error: 'Invalid automation mode' });
    }
    
    // Check for existing running automation
    const run = await withTenant(req.user!.userId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${activeRunKey(req.user!.userId)}, 0))`;
      const existing = await tx.automationRun.findFirst({ where: { userId: req.user!.userId, status: 'RUNNING' } });
      if (existing) return null;
      return tx.automationRun.create({ data: { userId: req.user!.userId, status: 'RUNNING', mode, activeKey: activeRunKey(req.user!.userId) } });
    });
    if (!run) return res.status(409).json({ success: false, error: 'Automation is already running' });

    return res.status(201).json({ success: true, data: run });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ success: false, error: 'Automation is already active' });
    }
    logRouteError('automation.start_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to start automation' });
  }
});

// POST /api/automation/pause
router.post('/pause', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await withTenant(req.user!.userId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${activeRunKey(req.user!.userId)}, 0))`;
      const run = await tx.automationRun.findFirst({ where: { userId: req.user!.userId, status: 'RUNNING' } });
      if (!run) return null;
      return tx.automationRun.update({ where: { id: run.id, userId: req.user!.userId }, data: { status: 'PAUSED' } });
    });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'No running automation found' });
    }
    return res.json({ success: true, data: updated });
  } catch (error) {
    logRouteError('automation.pause_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to pause automation' });
  }
});

// POST /api/automation/resume
router.post('/resume', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await withTenant(req.user!.userId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${activeRunKey(req.user!.userId)}, 0))`;
      const run = await tx.automationRun.findFirst({ where: { userId: req.user!.userId, status: 'PAUSED' } });
      if (!run) return null;
      return tx.automationRun.update({ where: { id: run.id, userId: req.user!.userId }, data: { status: 'RUNNING', activeKey: activeRunKey(req.user!.userId) } });
    });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'No paused automation found' });
    }
    return res.json({ success: true, data: updated });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ success: false, error: 'Automation is already active' });
    }
    logRouteError('automation.resume_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to resume automation' });
  }
});

// POST /api/automation/stop
router.post('/stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await withTenant(req.user!.userId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${activeRunKey(req.user!.userId)}, 0))`;
      const run = await tx.automationRun.findFirst({ where: { userId: req.user!.userId, status: { in: ['RUNNING', 'PAUSED'] } } });
      if (!run) return null;
      return tx.automationRun.update({ where: { id: run.id, userId: req.user!.userId }, data: { status: 'STOPPED', stoppedAt: new Date(), activeKey: null } });
    });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'No active automation found' });
    }
    return res.json({ success: true, data: updated });
  } catch (error) {
    logRouteError('automation.stop_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to stop automation' });
  }
});

// POST /api/automation/emergency-stop
router.post('/emergency-stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Stop ALL active runs
    await withTenant(req.user!.userId, tx => tx.automationRun.updateMany({
      where: {
        userId: req.user!.userId,
        status: { in: ['RUNNING', 'PAUSED'] },
      },
      data: { status: 'EMERGENCY_STOPPED', stoppedAt: new Date(), activeKey: null },
    }));
    
    return res.json({ success: true, message: 'Emergency stop executed. All automation halted.' });
  } catch (error) {
    logRouteError('automation.emergency_stop_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Emergency stop failed' });
  }
});

// POST /api/automation/jobs/:jobId/cancel
router.post('/jobs/:jobId/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const job = await cancelAutomationJob(req.params.jobId, req.user!.userId);
    return res.json({ success: true, data: job });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Automation job not found' });
      if (error.code === 'TERMINAL') return res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Automation job is terminal' });
    }
    logRouteError('automation.job_cancel_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, automationJobId: req.params.jobId });
    return res.status(500).json({ success: false, error: 'Failed to cancel automation job' });
  }
});

// POST /api/automation/jobs/:jobId/replay
router.post('/jobs/:jobId/replay', validateBody({
  reason: { type: 'string', required: true, minLength: 3, maxLength: 2_000 },
  maxAttempts: { type: 'number', min: 1, max: 20 },
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const replay = await replayDeadLetterAutomationJob({
      jobId: req.params.jobId,
      userId: req.user!.userId,
      reason: req.body.reason,
      correlationId: randomUUID(),
      maxAttempts: req.body.maxAttempts,
    });
    return res.status(201).json({ success: true, data: replay });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Automation job not found' });
      if (error.code === 'TERMINAL') return res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Automation job cannot be replayed' });
      if (error.code === 'INVALID_INPUT') return res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Invalid replay request' });
    }
    logRouteError('automation.job_replay_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, automationJobId: req.params.jobId });
    return res.status(500).json({ success: false, error: 'Failed to replay automation job' });
  }
});

// GET /api/automation/metrics
router.get('/metrics', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = _req.user!.userId;
    let queueMetrics: Awaited<ReturnType<typeof collectApplicationQueueMetrics>> | null = null;
    try {
      queueMetrics = await collectApplicationQueueMetrics();
    } catch {
      // PostgreSQL-backed metrics remain useful when transient Redis metrics
      // are unavailable; callers can distinguish this from an empty queue.
      queueMetrics = null;
    }
    const [jobs, attempts, failures, browserSessions, jobRetryGroups, attemptDurations, browserSessionDurations, pendingVerifications] = await withTenant(userId, tx => Promise.all([
      tx.automationJob.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
      tx.applicationAttempt.groupBy({ by: ['status'], where: { application: { userId } }, _count: { _all: true } }),
      tx.failureRecord.groupBy({ by: ['category', 'code'], where: { userId }, _count: { _all: true } }),
      tx.browserSessionReference.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
      tx.automationJob.groupBy({ by: ['attemptCount'], where: { userId }, _count: { _all: true } }),
      tx.applicationAttempt.findMany({ where: { application: { userId }, completedAt: { not: null } }, select: { startedAt: true, completedAt: true }, orderBy: { completedAt: 'desc' }, take: 10_000 }),
      tx.browserSessionReference.findMany({ where: { userId, closedAt: { not: null } }, select: { createdAt: true, closedAt: true }, orderBy: { closedAt: 'desc' }, take: 10_000 }),
      tx.humanVerification.findMany({ where: { userId, status: 'PENDING' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 10_000 }),
    ]));
    const totalAttempts = jobRetryGroups.reduce((sum, group) => sum + group.attemptCount * group._count._all, 0);
    const jobCount = jobRetryGroups.reduce((sum, group) => sum + group._count._all, 0);
    const jobsWithRetries = jobRetryGroups.filter(group => group.attemptCount > 1).reduce((sum, group) => sum + group._count._all, 0);
    const pendingVerificationSummary = summarizePendingVerificationAges(pendingVerifications);
    const alerts = deriveAutomationAlerts({ queueMetrics, retryMetrics: { jobsWithRetries }, browserSessions, pendingVerification: pendingVerificationSummary });
    await persistAutomationAlerts(userId, alerts, normalizeCorrelationId(_req.get('x-correlation-id')));
    return res.json({ success: true, data: {
      jobs, attempts, failures, browserSessions,
      queueMetrics,
      retryMetrics: { jobCount, totalAttempts, jobsWithRetries },
      executionDuration: summarizeExecutionDurations(attemptDurations),
      browserSessionDuration: summarizeExecutionDurations(browserSessionDurations.map(session => ({ startedAt: session.createdAt, completedAt: session.closedAt }))),
      pendingVerification: pendingVerificationSummary,
      alerts,
    } });
  } catch (error) {
    logRouteError('automation.metrics_failure', error, { correlationId: _req.get('x-correlation-id'), userId: _req.user?.userId });
    return res.status(503).json({ success: false, error: 'Failed to collect automation metrics' });
  }
});

// GET /api/automation/events
router.get('/events', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    const limit = parseLimit(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ success: false, error: 'limit must be an integer between 1 and 200' });

    const events = await withTenant(req.user!.userId, async tx => {
      let selectedRunId: string | undefined;
      if (runId) {
        const ownedRun = await tx.automationRun.findFirst({ where: { id: runId, userId: req.user!.userId }, select: { id: true } });
        if (!ownedRun) return null;
        selectedRunId = ownedRun.id;
      } else {
        const latestRun = await tx.automationRun.findFirst({ where: { userId: req.user!.userId }, orderBy: { startedAt: 'desc' }, select: { id: true } });
        selectedRunId = latestRun?.id;
      }
      if (!selectedRunId) return [];
      return tx.automationEvent.findMany({ where: { runId: selectedRunId }, orderBy: { timestamp: 'desc' }, take: limit });
    });
    if (events === null) return res.status(404).json({ success: false, error: 'Automation run not found' });
    
    return res.json({ success: true, data: events });
  } catch (error) {
    logRouteError('automation.events_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch events' });
  }
});

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export { router as automationRoutes };
