import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { createAutomationJob } from '../services/automation-jobs';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord, parsePagination } from '../middleware/validate';
import { cancelDiscoveryRun, createDiscoveryRuns, getDiscoveryRun, listDiscoveryRuns } from '../services/job-discovery';
import { logRouteError } from '../observability/structured-log';

const router = Router();
router.use(authenticate);

const SORT_FIELDS = new Set(['discoveredAt', 'postedAt', 'updatedAt', 'title', 'company', 'salaryMin', 'salaryMax']);

// GET /api/jobs - List jobs with filters
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pagination = parsePagination(req.query);
    if (!pagination) return res.status(400).json({ success: false, error: 'Invalid pagination parameters' });
    const { page, pageSize } = pagination;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : undefined;
    const remoteType = typeof req.query.remoteType === 'string' ? req.query.remoteType : undefined;
    const requestedSort = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'discoveredAt';
    const sortBy = SORT_FIELDS.has(requestedSort) ? requestedSort : null;
    const sortOrder = req.query.sortOrder === undefined ? 'desc' : req.query.sortOrder;
    if (!sortBy || (sortOrder !== 'asc' && sortOrder !== 'desc')) {
      return res.status(400).json({ success: false, error: 'Invalid sort parameters' });
    }

    const where: any = { isActive: true };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (remoteType) where.remoteType = remoteType;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: {
          analysis: true,
          matches: { where: { userId: req.user!.userId } },
          applications: { where: { userId: req.user!.userId }, select: { id: true, status: true } },
        },
        orderBy: { [sortBy]: sortOrder },
        skip: page * pageSize,
        take: pageSize,
      }),
      prisma.job.count({ where }),
    ]);

    return res.json({
      success: true,
      data: jobs,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    logRouteError('jobs.list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch jobs' });
  }
});

// POST /api/jobs/discover - Create durable discovery runs for configured ATS accounts.
router.post('/discover', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isRecord(req.body)) return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    const requestKey = parseRequestKey(req.get('Idempotency-Key'));
    if (!requestKey) {
      return res.status(400).json({ success: false, error: 'Idempotency-Key must be 16 to 128 visible ASCII characters' });
    }

    const greenhouseBoards = parseStringArray(req.body.greenhouseBoards, 20);
    const leverCompanies = parseStringArray(req.body.leverCompanies, 20);
    const ashbyBoards = parseStringArray(req.body.ashbyBoards, 20);
    const query = optionalString(req.body.query, 200);
    const location = optionalString(req.body.location, 200);
    if (!greenhouseBoards || !leverCompanies || !ashbyBoards || query === null || location === null) {
      return res.status(400).json({ success: false, error: 'Board lists must contain at most 20 safe slugs and filters must be strings' });
    }
    if (greenhouseBoards.length + leverCompanies.length + ashbyBoards.length === 0) {
      return res.status(400).json({ success: false, error: 'Provide at least one Greenhouse, Lever, or Ashby account slug' });
    }

    const runs = await createDiscoveryRuns(req.user!.userId, {
      greenhouseBoards, leverCompanies, ashbyBoards,
      query: query ?? undefined, location: location ?? undefined,
    }, requestKey as `${string}-${string}-${string}-${string}-${string}`);
    return res.status(202).json(discoveryRunsAccepted(runs));
  } catch (error) {
    if (hasErrorCode(error, 'REQUEST_CONFLICT') || hasErrorCode(error, 'IN_PROGRESS')) {
      return res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Discovery request conflicts with existing work' });
    }
    if (hasErrorCode(error, 'INVALID_INPUT')) {
      return res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Invalid discovery request' });
    }
    logRouteError('jobs.discovery_creation_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to create discovery runs' });
  }
});

// GET /api/jobs/discovery-runs - Tenant-scoped durable run summaries.
router.get('/discovery-runs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = parseRunLimit(req.query.limit);
    if (limit === null) return res.status(400).json({ success: false, error: 'limit must be an integer between 1 and 100' });
    return res.json(discoveryRunsListed(await listDiscoveryRuns(req.user!.userId, limit)));
  } catch (error) {
    logRouteError('jobs.discovery_list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch discovery runs' });
  }
});

// GET /api/jobs/discovery-runs/:runId - Tenant-scoped durable run status.
router.get('/discovery-runs/:runId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isSafeId(req.params.runId)) return res.status(400).json({ success: false, error: 'Invalid discovery run id' });
    const run = await getDiscoveryRun(req.user!.userId, req.params.runId);
    if (!run) return res.status(404).json({ success: false, error: 'Discovery run not found' });
    return res.json(discoveryRunResult(run));
  } catch (error) {
    logRouteError('jobs.discovery_status_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch discovery run' });
  }
});

// POST /api/jobs/discovery-runs/:runId/cancel - Cancel tenant-owned durable discovery work.
router.post('/discovery-runs/:runId/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isSafeId(req.params.runId)) return res.status(400).json({ success: false, error: 'Invalid discovery run id' });
    const cancelled = await cancelDiscoveryRun(req.user!.userId, req.params.runId);
    if (!cancelled) return res.status(404).json({ success: false, error: 'Discovery run not found' });
    return res.json(discoveryRunResult(cancelled));
  } catch (error) {
    if (hasErrorCode(error, 'NOT_FOUND')) return res.status(404).json({ success: false, error: 'Discovery run not found' });
    if (hasErrorCode(error, 'TERMINAL')) {
      return res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Discovery run is terminal' });
    }
    logRouteError('jobs.discovery_cancellation_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to cancel discovery run' });
  }
});

function parseStringArray(value: unknown, max: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const values = value.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '');
  return values.every(item => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(item)) ? [...new Set(values)] : null;
}

function optionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) return null;
  const normalized = value.trim();
  return normalized || undefined;
}

function parseRunLimit(value: unknown): number | null {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 100 ? parsed : null;
}

function parseRequestKey(value: unknown): string | null {
  return typeof value === 'string' && /^[\x21-\x7E]{16,128}$/.test(value) ? value : null;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

// POST /api/jobs/:id/match - Queue an authenticated tenant's deterministic match computation.
router.post('/:id/match', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isSafeId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid job id' });
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    const automationJob = await createAutomationJob({
      userId: req.user!.userId, type: 'MATCH_JOB', payload: { jobId: job.id }, payloadVersion: 1,
      correlationId: job.id, idempotencyKey: `match-job:${req.user!.userId}:${job.id}`, maxAttempts: 3,
    });
    return res.status(automationJob.replayed ? 200 : 202).json({ success: true, data: { id: automationJob.id, status: automationJob.status, replayed: automationJob.replayed } });
  } catch (error) {
    if (hasErrorCode(error, 'IDEMPOTENCY_CONFLICT')) return res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Matching request conflicts with existing work' });
    logRouteError('jobs.match_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: req.params.id });
    return res.status(500).json({ success: false, error: 'Failed to queue job matching' });
  }
});

// GET /api/jobs/:id - Job detail. Keep concrete discovery routes above this parameter route.
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        analysis: true,
        matches: { where: { userId: req.user!.userId } },
        applications: { where: { userId: req.user!.userId } },
        resumeVersions: { where: { resume: { userId: req.user!.userId } } },
      },
    });
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    return res.json({ success: true, data: job });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch job' });
  }
});

export function discoveryRunsAccepted<T>(runs: T[]) {
  return { success: true as const, data: { runs } };
}

export function discoveryRunsListed<T>(runs: T[]) {
  return { success: true as const, data: runs };
}

export function discoveryRunResult<T>(run: T) {
  return { success: true as const, data: run };
}

export { router as jobRoutes };
