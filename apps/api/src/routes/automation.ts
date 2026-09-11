import { randomUUID } from 'node:crypto';
import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { parseLimit, validateBody } from '../middleware/validate';
import { cancelAutomationJob, replayDeadLetterAutomationJob } from '../services/automation-jobs';

const router = Router();
router.use(authenticate);

const AUTOMATION_MODES = new Set(['ASSISTED', 'SMART_AUTO', 'REVIEW_REQUIRED']);
const activeRunKey = (userId: string) => `active:${userId}`;

// GET /api/automation/status
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const run = await prisma.automationRun.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { startedAt: 'desc' },
    });
    return res.json({ success: true, data: run });
  } catch (error) {
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
    const existing = await prisma.automationRun.findFirst({
      where: { userId: req.user!.userId, status: 'RUNNING' },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Automation is already running' });
    }
    
    const run = await prisma.automationRun.create({
      data: {
        userId: req.user!.userId,
        status: 'RUNNING',
        mode,
        activeKey: activeRunKey(req.user!.userId),
      },
    });

    return res.status(201).json({ success: true, data: run });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ success: false, error: 'Automation is already active' });
    }
    return res.status(500).json({ success: false, error: 'Failed to start automation' });
  }
});

// POST /api/automation/pause
router.post('/pause', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const run = await prisma.automationRun.findFirst({
      where: { userId: req.user!.userId, status: 'RUNNING' },
    });
    if (!run) {
      return res.status(404).json({ success: false, error: 'No running automation found' });
    }
    
    const updated = await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: 'PAUSED' },
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to pause automation' });
  }
});

// POST /api/automation/resume
router.post('/resume', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const run = await prisma.automationRun.findFirst({
      where: { userId: req.user!.userId, status: 'PAUSED' },
    });
    if (!run) {
      return res.status(404).json({ success: false, error: 'No paused automation found' });
    }
    
    const updated = await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', activeKey: activeRunKey(req.user!.userId) },
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ success: false, error: 'Automation is already active' });
    }
    return res.status(500).json({ success: false, error: 'Failed to resume automation' });
  }
});

// POST /api/automation/stop
router.post('/stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const run = await prisma.automationRun.findFirst({
      where: { userId: req.user!.userId, status: { in: ['RUNNING', 'PAUSED'] } },
    });
    if (!run) {
      return res.status(404).json({ success: false, error: 'No active automation found' });
    }
    
    const updated = await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: 'STOPPED', stoppedAt: new Date(), activeKey: null },
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to stop automation' });
  }
});

// POST /api/automation/emergency-stop
router.post('/emergency-stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Stop ALL active runs
    await prisma.automationRun.updateMany({
      where: {
        userId: req.user!.userId,
        status: { in: ['RUNNING', 'PAUSED'] },
      },
      data: { status: 'EMERGENCY_STOPPED', stoppedAt: new Date(), activeKey: null },
    });
    
    return res.json({ success: true, message: 'Emergency stop executed. All automation halted.' });
  } catch (error) {
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
    return res.status(500).json({ success: false, error: 'Failed to replay automation job' });
  }
});

// GET /api/automation/metrics
router.get('/metrics', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const jobs = await prisma.automationJob.groupBy({
      by: ['status'],
      where: { userId: _req.user!.userId },
      _count: { _all: true },
    });
    return res.json({ success: true, data: { jobs } });
  } catch (error) {
    return res.status(503).json({ success: false, error: 'Failed to collect automation metrics' });
  }
});

// GET /api/automation/events
router.get('/events', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    const limit = parseLimit(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ success: false, error: 'limit must be an integer between 1 and 200' });

    let selectedRunId: string | undefined;
    if (runId) {
      const ownedRun = await prisma.automationRun.findFirst({ where: { id: runId, userId: req.user!.userId }, select: { id: true } });
      if (!ownedRun) return res.status(404).json({ success: false, error: 'Automation run not found' });
      selectedRunId = ownedRun.id;
    } else {
      const latestRun = await prisma.automationRun.findFirst({
        where: { userId: req.user!.userId },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      selectedRunId = latestRun?.id;
    }

    if (!selectedRunId) return res.json({ success: true, data: [] });
    const events = await prisma.automationEvent.findMany({
      where: { runId: selectedRunId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    
    return res.json({ success: true, data: events });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch events' });
  }
});

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export { router as automationRoutes };
