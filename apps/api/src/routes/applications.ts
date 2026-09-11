import { Router, Response } from 'express';
import { ApplicationStatus } from '@prisma/client';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { parsePagination, validateBody } from '../middleware/validate';
import { ApplicationTransitionError, transitionApplication, type TransitionApplicationInput } from '../services/application-state-machine';
import { ApplicationCreationError, createApplicationIntent, type CreateApplicationIntentInput } from '../services/application-creation';
import { createAutomationJob } from '../services/automation-jobs';
import { authorizeSubmission, SubmissionEngineError } from '../services/submission-engine';

const router = Router();
router.use(authenticate);

const APPLICATION_STATUSES = new Set(Object.values(ApplicationStatus));

type UserTransitionBody = Pick<TransitionApplicationInput, 'expectedVersion' | 'reason' | 'idempotencyKey' | 'correlationId' | 'metadata'> & {
  status: ApplicationStatus;
  actorType?: unknown;
  actorId?: unknown;
};

export function userTransitionInput(applicationId: string, userId: string, body: UserTransitionBody): TransitionApplicationInput {
  return {
    applicationId,
    userId,
    toStatus: body.status,
    expectedVersion: body.expectedVersion,
    actorType: 'USER',
    actorId: userId,
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
    correlationId: body.correlationId,
    metadata: body.metadata,
  };
}

export interface CreateApplicationBody {
  jobId?: unknown;
  resumeVersionId?: unknown;
  searchProfileId?: unknown;
  automationRunId?: unknown;
  correlationId?: unknown;
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function createApplicationInput(
  userId: string,
  body: CreateApplicationBody,
  idempotencyKey: string,
): CreateApplicationIntentInput | null {
  const jobId = optionalText(body.jobId);
  const resumeVersionId = optionalText(body.resumeVersionId);
  const searchProfileId = optionalText(body.searchProfileId);
  const automationRunId = optionalText(body.automationRunId);
  const correlationId = optionalText(body.correlationId);
  if (!jobId || !resumeVersionId || !searchProfileId || automationRunId === null || correlationId === null) return null;
  return {
    userId,
    jobId,
    resumeVersionId,
    searchProfileId,
    ...(automationRunId ? { automationRunId } : {}),
    correlationId: correlationId || `application-create:${userId}:${jobId}`,
    idempotencyKey,
  };
}

// POST /api/applications - Create one tenant application and queue policy evaluation.
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const idempotencyHeader = req.get('Idempotency-Key');
    const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return res.status(400).json({ success: false, error: 'Idempotency-Key is required and must be at most 200 characters' });
    }
    const input = createApplicationInput(req.user!.userId, req.body ?? {}, idempotencyKey);
    if (!input) {
      return res.status(400).json({ success: false, error: 'jobId, resumeVersionId, and searchProfileId are required strings' });
    }
    const created = await createApplicationIntent(input);
    return res.status(created.replayed ? 200 : 202).json({
      success: true,
      data: { application: created.application, automationJob: created.automationJob, replayed: created.replayed },
    });
  } catch (error) {
    if (error instanceof ApplicationCreationError) {
      const status = error.code === 'INVALID' ? 400 : error.code === 'NOT_FOUND' ? 404 : error.code === 'APPLICATION_EXISTS' ? 409 : 422;
      return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
    return res.status(500).json({ success: false, error: 'Failed to create application' });
  }
});

// GET /api/applications
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, error: 'Invalid pagination parameters' });
    const { page, pageSize } = pagination;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !APPLICATION_STATUSES.has(status as ApplicationStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid application status' });
    }

    const where: any = { userId: req.user!.userId };
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          job: { select: { id: true, title: true, company: true, location: true, remoteType: true } },
          resumeVersion: { select: { id: true, atsScoreOverall: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: page * pageSize,
        take: pageSize,
      }),
      prisma.application.count({ where }),
    ]);

    return res.json({
      success: true,
      data: applications,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch applications' });
  }
});

// GET /api/applications/:id
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        job: true,
        resumeVersion: true,
        coverLetter: true,
        attempts: { orderBy: { startedAt: 'desc' } },
        documents: true,
        interviews: true,
      },
    });
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }
    return res.json({ success: true, data: application });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch application' });
  }
});

// POST /api/applications/:id/evaluate-quality - Queue deterministic application policy evaluation.
router.post('/:id/evaluate-quality', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    const searchProfileId = typeof req.body?.searchProfileId === 'string' ? req.body.searchProfileId.trim() : '';
    if (!applicationId || !searchProfileId) return res.status(400).json({ success: false, error: 'application and search profile identifiers are required' });
    const [application, profile] = await Promise.all([
      prisma.application.findFirst({ where: { id: applicationId, userId: req.user!.userId }, select: { id: true } }),
      prisma.searchProfile.findFirst({ where: { id: searchProfileId, userId: req.user!.userId, isActive: true }, select: { id: true } }),
    ]);
    if (!application || !profile) return res.status(404).json({ success: false, error: 'Application or active search profile not found' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      applicationId,
      type: 'EVALUATE_APPLICATION_QUALITY',
      payload: { applicationId, searchProfileId },
      payloadVersion: 1,
      correlationId: applicationId,
      idempotencyKey: `evaluate-application-quality:${req.user!.userId}:${applicationId}:${searchProfileId}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to queue application quality evaluation' });
  }
});

// POST /api/applications/:id/complete-greenhouse - Queue fail-closed Greenhouse form completion.
router.post('/:id/complete-greenhouse', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    if (!applicationId) return res.status(400).json({ success: false, error: 'application identifier is required' });
    const application = await prisma.application.findFirst({
      where: { id: applicationId, userId: req.user!.userId, status: 'APPLICATION_STARTED', job: { source: 'GREENHOUSE' } },
      select: { id: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application ready for Greenhouse completion not found' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      applicationId,
      type: 'COMPLETE_GREENHOUSE_APPLICATION',
      payload: { applicationId },
      payloadVersion: 1,
      correlationId: `greenhouse-completion:${applicationId}`,
      idempotencyKey: `complete-greenhouse:${req.user!.userId}:${applicationId}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to queue Greenhouse form completion' });
  }
});

// POST /api/applications/:id/complete-lever - Queue fail-closed Lever form completion.
router.post('/:id/complete-lever', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    if (!applicationId) return res.status(400).json({ success: false, error: 'application identifier is required' });
    const application = await prisma.application.findFirst({
      where: { id: applicationId, userId: req.user!.userId, status: 'APPLICATION_STARTED', job: { source: 'LEVER' } },
      select: { id: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application ready for Lever completion not found' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      applicationId,
      type: 'COMPLETE_LEVER_APPLICATION',
      payload: { applicationId },
      payloadVersion: 1,
      correlationId: `lever-completion:${applicationId}`,
      idempotencyKey: `complete-lever:${req.user!.userId}:${applicationId}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to queue Lever form completion' });
  }
});

// POST /api/applications/:id/authorize-submission - Create a narrow, irreversible user authorization.
router.post('/:id/authorize-submission', validateBody({
  expectedVersion: { type: 'number', required: true, min: 1 },
  correlationId: { type: 'string', required: true, minLength: 1, maxLength: 200 },
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const idempotencyHeader = req.get('Idempotency-Key');
    const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return res.status(400).json({ success: false, error: 'Idempotency-Key is required and must be at most 200 characters' });
    }
    const result = await authorizeSubmission({
      userId: req.user!.userId,
      applicationId: req.params.id.trim(),
      expectedVersion: req.body.expectedVersion,
      idempotencyKey,
      correlationId: req.body.correlationId,
    });
    return res.status(result.replayed ? 200 : 202).json({
      success: true,
      data: { authorizationId: result.authorization.id, automationJobId: result.automationJob.id, status: result.application?.status ?? result.authorization.status },
      replayed: result.replayed,
    });
  } catch (error) {
    if (error instanceof SubmissionEngineError) {
      const status = error.code === 'INVALID' ? 400
        : error.code === 'NOT_FOUND' ? 404
          : error.code === 'STALE_VERSION' || error.code === 'CONFLICT' ? 409 : 422;
      return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
    return res.status(500).json({ success: false, error: 'Failed to authorize application submission' });
  }
});

// PATCH /api/applications/:id/status
router.patch('/:id/status', validateBody({
  status: { type: 'string', required: true, maxLength: 40 },
  expectedVersion: { type: 'number', required: true, min: 1 },
  reason: { type: 'string', required: true, minLength: 1, maxLength: 10_000 },
  idempotencyKey: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  correlationId: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  metadata: { type: 'object' },
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, expectedVersion, reason, idempotencyKey, correlationId, metadata } = req.body;
    if (!APPLICATION_STATUSES.has(status as ApplicationStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid application status' });
    }
    if ((status as ApplicationStatus) === ApplicationStatus.SUBMISSION_PENDING) {
      return res.status(422).json({ success: false, error: 'Use the explicit submission authorization endpoint for this irreversible transition' });
    }
    const result = await transitionApplication(userTransitionInput(req.params.id, req.user!.userId, {
      status: status as ApplicationStatus,
      expectedVersion,
      reason,
      idempotencyKey,
      correlationId,
      metadata,
    }));
    return res.json({ success: true, data: result.application, replayed: result.replayed });
  } catch (error) {
    if (error instanceof ApplicationTransitionError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'STALE_VERSION' || error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 422;
      return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
    return res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

export { router as applicationRoutes };
