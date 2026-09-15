import { Router, Response } from 'express';
import { ApplicationStatus } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { parsePagination, validateBody } from '../middleware/validate';
import { ApplicationTransitionError, transitionApplication, type TransitionApplicationInput } from '../services/application-state-machine';
import { ApplicationCreationError, createApplicationIntent, type CreateApplicationIntentInput } from '../services/application-creation';
import { AutomationJobError, createAutomationJob } from '../services/automation-jobs';
import { authorizeSubmission, SubmissionEngineError } from '../services/submission-engine';
import { decideOffer, recordInterview, recordOffer, type OfferDecision } from '../services/application-lifecycle';
import { ApplicationAnswerError, decideApplicationAnswer, saveApplicationAnswerDraft, type ApplicationAnswerDecision, type ApplicationAnswerSource } from '../services/application-answers';
import { scheduleApplicationRun, SchedulerError } from '../services/durable-scheduler';
import { logRouteError } from '../observability/structured-log';

const router = Router();
router.use(authenticate);

const APPLICATION_STATUSES = new Set(Object.values(ApplicationStatus));

const APPLICATION_ANSWER_SOURCES = new Set<ApplicationAnswerSource>(['USER_PROFILE', 'USER_INPUT', 'COVER_LETTER', 'AI_SUGGESTION']);
const isAnswerValue = (value: unknown): value is string | boolean | readonly string[] => typeof value === 'string' || typeof value === 'boolean'
  || (Array.isArray(value) && value.every(item => typeof item === 'string'));

// GET /api/applications/:id/answers - Read tenant-owned questions and answer review state.
router.get('/:id/answers', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const questions = await withTenant(req.user!.userId, tx => tx.applicationQuestion.findMany({
      where: { applicationId: req.params.id.trim(), userId: req.user!.userId },
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      include: { answers: true },
    }));
    return res.json({ success: true, data: questions });
  } catch (error) {
    logRouteError('applications.answers_list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to load application answers' });
  }
});

// POST /api/applications/:id/answers - Save an unapproved draft; approval is a separate action.
router.post('/:id/answers', async (req: AuthenticatedRequest, res: Response) => {
  const questionId = typeof req.body?.questionId === 'string' ? req.body.questionId.trim() : '';
  const source = req.body?.source;
  const expectedVersion = req.body?.expectedVersion;
  const provenance = req.body?.provenance;
  if (!questionId || !isAnswerValue(req.body?.value) || !APPLICATION_ANSWER_SOURCES.has(source)
    || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))
    || (provenance !== undefined && (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)))) {
    return res.status(400).json({ success: false, error: 'questionId, supported value, source, and valid provenance are required' });
  }
  try {
    const answer = await saveApplicationAnswerDraft({
      userId: req.user!.userId, applicationId: req.params.id.trim(), questionId, value: req.body.value,
      source: source as ApplicationAnswerSource, provenance: provenance as Record<string, unknown> | undefined, expectedVersion,
    });
    return res.status(201).json({ success: true, data: answer });
  } catch (error) {
    if (error instanceof ApplicationAnswerError) {
      return res.status(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400).json({ success: false, error: error.message, code: error.code });
    }
    logRouteError('applications.answer_draft_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to save application answer draft' });
  }
});

// PATCH /api/applications/:id/answers/:answerId - Explicitly approve or reject a draft.
router.patch('/:id/answers/:answerId', async (req: AuthenticatedRequest, res: Response) => {
  const decision = req.body?.decision;
  const expectedVersion = req.body?.expectedVersion;
  if (!['APPROVE', 'REJECT'].includes(decision) || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) {
    return res.status(400).json({ success: false, error: 'decision and valid expectedVersion are required' });
  }
  try {
    const answer = await decideApplicationAnswer({
      userId: req.user!.userId, applicationId: req.params.id.trim(), answerId: req.params.answerId.trim(),
      decision: decision as ApplicationAnswerDecision, expectedVersion,
    });
    return res.json({ success: true, data: answer, deleted: answer === null });
  } catch (error) {
    if (error instanceof ApplicationAnswerError) {
      return res.status(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400).json({ success: false, error: error.message, code: error.code });
    }
    logRouteError('applications.answer_decision_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to decide application answer' });
  }
});

// POST /api/applications/:id/verify-submission - Persist independently observed provider evidence.
router.post('/:id/verify-submission', async (req: AuthenticatedRequest, res: Response) => {
  // Confirmation evidence is produced by the trusted browser/verifier worker.
  // Rejecting this public mutation prevents caller-supplied IDs/hashes from
  // becoming independent proof of submission.
  return res.status(403).json({ success: false, error: 'Submission verification is restricted to the trusted verifier boundary', code: 'PRECONDITION_FAILED' });
});

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
    logRouteError('applications.create_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
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

    const [applications, total] = await withTenant(req.user!.userId, tx => Promise.all([
      tx.application.findMany({
        where,
        include: {
          job: { select: { id: true, title: true, company: true, location: true, remoteType: true } },
          resumeVersion: { select: { id: true, atsScoreOverall: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: page * pageSize,
        take: pageSize,
      }),
      tx.application.count({ where }),
    ]));

    return res.json({
      success: true,
      data: applications,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    logRouteError('applications.list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch applications' });
  }
});

// GET /api/applications/:id
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await withTenant(req.user!.userId, tx => tx.application.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        job: true,
        resumeVersion: true,
        coverLetter: true,
        attempts: { orderBy: { startedAt: 'desc' } },
        documents: true,
        interviews: true,
        offers: true,
        jobs: { where: { type: { in: ['COMPLETE_GREENHOUSE_APPLICATION', 'COMPLETE_LEVER_APPLICATION'] } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, status: true, availableAt: true, attemptCount: true, completedAt: true, cancelledAt: true, lastError: true } },
        emailOutcomes: { orderBy: { receivedAt: 'desc' }, take: 20, select: { id: true, applicationId: true, classification: true, confidence: true, receivedAt: true, reviewedAt: true, reviewedBy: true, createdAt: true } },
      },
    }));
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }
    return res.json({ success: true, data: application });
  } catch (error) {
    logRouteError('applications.detail_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to fetch application' });
  }
});

function boundedText(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

// POST /api/applications/:id/interviews - Record an explicit, tenant-owned interview event.
router.post('/:id/interviews', async (req: AuthenticatedRequest, res: Response) => {
  const sourceEventId = boundedText(req.get('Idempotency-Key'), 200);
  const type = boundedText(req.body?.type);
  const company = boundedText(req.body?.company);
  const role = boundedText(req.body?.role);
  const date = req.body?.date === undefined ? undefined : new Date(req.body.date);
  const round = req.body?.round === undefined ? undefined : req.body.round;
  if (!sourceEventId || !type || !company || !role || (date && !Number.isFinite(date.getTime()))
    || (round !== undefined && (!Number.isSafeInteger(round) || round < 1 || round > 100))) {
    return res.status(400).json({ success: false, error: 'Idempotency-Key, type, company, role, and valid interview fields are required' });
  }
  try {
    const interview = await recordInterview({
      userId: req.user!.userId,
      applicationId: req.params.id.trim(),
      sourceEventId,
      type,
      company,
      role,
      date,
      round,
      interviewer: boundedText(req.body?.interviewer, 500),
      meetingUrl: boundedText(req.body?.meetingUrl, 2_000),
    });
    return res.status(201).json({ success: true, data: interview });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Application not found' });
    if (message.includes('requires')) return res.status(409).json({ success: false, error: message });
    logRouteError('applications.interview_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to record interview' });
  }
});

// POST /api/applications/:id/offers - Record an explicit, tenant-owned offer event.
router.post('/:id/offers', async (req: AuthenticatedRequest, res: Response) => {
  const sourceEventId = boundedText(req.get('Idempotency-Key'), 200);
  const company = boundedText(req.body?.company);
  const role = boundedText(req.body?.role);
  const startDate = req.body?.startDate ? new Date(req.body.startDate) : undefined;
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : undefined;
  const salaryOffered = typeof req.body?.salaryOffered === 'number' ? req.body.salaryOffered : undefined;
  if (!sourceEventId || !company || !role || (startDate && !Number.isFinite(startDate.getTime())) || (expiresAt && !Number.isFinite(expiresAt.getTime())) || (salaryOffered !== undefined && (!Number.isFinite(salaryOffered) || salaryOffered < 0))) return res.status(400).json({ success: false, error: 'Idempotency-Key, company, role, and valid offer fields are required' });
  try {
    const offer = await recordOffer({ userId: req.user!.userId, applicationId: req.params.id.trim(), sourceEventId, company, role, salaryOffered, currency: boundedText(req.body?.currency, 20), benefits: boundedText(req.body?.benefits, 5_000), startDate, expiresAt });
    return res.status(201).json({ success: true, data: offer });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Application not found' });
    if (message.includes('Cannot transition')) return res.status(409).json({ success: false, error: message });
    logRouteError('applications.offer_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to record offer' });
  }
});

router.patch('/:id/offers/:offerId/decision', async (req: AuthenticatedRequest, res: Response) => {
  const decision = req.body?.decision;
  const sourceEventId = boundedText(req.get('Idempotency-Key'), 200);
  if (!sourceEventId || !['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'].includes(decision)) return res.status(400).json({ success: false, error: 'Idempotency-Key and valid offer decision are required' });
  try {
    const offer = await decideOffer({ userId: req.user!.userId, applicationId: req.params.id.trim(), offerId: req.params.offerId.trim(), sourceEventId, decision: decision as OfferDecision });
    return res.json({ success: true, data: offer });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Offer not found' });
    if (message.includes('already') || message.includes('changed')) return res.status(409).json({ success: false, error: message });
    logRouteError('applications.offer_decision_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to decide offer' });
  }
});

// POST /api/applications/:id/evaluate-quality - Queue deterministic application policy evaluation.
router.post('/:id/evaluate-quality', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    const searchProfileId = typeof req.body?.searchProfileId === 'string' ? req.body.searchProfileId.trim() : '';
    if (!applicationId || !searchProfileId) return res.status(400).json({ success: false, error: 'application and search profile identifiers are required' });
    const [application, profile] = await withTenant(req.user!.userId, tx => Promise.all([
      tx.application.findFirst({ where: { id: applicationId, userId: req.user!.userId }, select: { id: true } }),
      tx.searchProfile.findFirst({ where: { id: searchProfileId, userId: req.user!.userId, isActive: true }, select: { id: true } }),
    ]));
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
  } catch (error) {
    logRouteError('applications.quality_queue_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to queue application quality evaluation' });
  }
});

// POST /api/applications/:id/complete-greenhouse - Queue fail-closed Greenhouse form completion.
router.post('/:id/complete-greenhouse', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    if (!applicationId) return res.status(400).json({ success: false, error: 'application identifier is required' });
    const application = await withTenant(req.user!.userId, tx => tx.application.findFirst({
      where: { id: applicationId, userId: req.user!.userId, status: 'APPLICATION_STARTED', job: { source: 'GREENHOUSE' } },
      select: { id: true },
    }));
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
  } catch (error) {
    logRouteError('applications.greenhouse_queue_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id, provider: 'GREENHOUSE' });
    return res.status(500).json({ success: false, error: 'Failed to queue Greenhouse form completion' });
  }
});

// POST /api/applications/:id/complete-lever - Queue fail-closed Lever form completion.
router.post('/:id/complete-lever', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationId = req.params.id.trim();
    if (!applicationId) return res.status(400).json({ success: false, error: 'application identifier is required' });
    const application = await withTenant(req.user!.userId, tx => tx.application.findFirst({
      where: { id: applicationId, userId: req.user!.userId, status: 'APPLICATION_STARTED', job: { source: 'LEVER' } },
      select: { id: true },
    }));
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
  } catch (error) {
    logRouteError('applications.lever_queue_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id, provider: 'LEVER' });
    return res.status(500).json({ success: false, error: 'Failed to queue Lever form completion' });
  }
});

// POST /api/applications/:id/schedule - Persist a future provider form run in AutomationJob.availableAt.
router.post('/:id/schedule', validateBody({
  runAt: { type: 'string', required: true, minLength: 1, maxLength: 80 },
  correlationId: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  automationRunId: { type: 'string', maxLength: 200 },
}), async (req: AuthenticatedRequest, res: Response) => {
  const scheduleBody = req.body as { runAt: string; correlationId: string; automationRunId?: string };
  const idempotencyKey = typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key')!.trim() : '';
  if (!idempotencyKey || idempotencyKey.length > 200) return res.status(400).json({ success: false, error: 'Idempotency-Key is required and must be at most 200 characters' });
  const runAt = new Date(scheduleBody.runAt);
  try {
    const queued = await scheduleApplicationRun({ userId: req.user!.userId, applicationId: req.params.id.trim(), automationRunId: scheduleBody.automationRunId, runAt, correlationId: scheduleBody.correlationId, idempotencyKey });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, availableAt: queued.availableAt, replayed: queued.replayed } });
  } catch (error) {
    if (error instanceof SchedulerError) return res.status(error.message.includes('not found') ? 404 : 422).json({ success: false, error: error.message });
    if (error instanceof AutomationJobError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : error.code === 'INVALID_INPUT' ? 400 : 422;
      return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
    logRouteError('applications.schedule_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to schedule application run' });
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
    logRouteError('applications.authorize_submission_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
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
    logRouteError('applications.status_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

export { router as applicationRoutes };
