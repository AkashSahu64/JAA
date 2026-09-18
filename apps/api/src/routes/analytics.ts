import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { logRouteError } from '../observability/structured-log';

const router = Router();
router.use(authenticate);
// Analytics contain tenant-owned application performance data and must never be
// retained by browser or intermediary caches.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const RESPONSE_STATUSES = ['REJECTED', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'WITHDRAWN'] as const;
const INTERVIEW_STATUSES = ['INTERVIEW', 'OFFER', 'ACCEPTED'] as const;
const OFFER_STATUSES = ['OFFER', 'ACCEPTED'] as const;
const ANALYTICS_PAGE_SIZE = 1_000;

/** Iterate large tenant datasets without materializing the entire history. */
async function forEachAnalyticsPage<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<readonly T[]>,
  consume: (row: T) => void,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const row of page) consume(row);
    if (page.length < ANALYTICS_PAGE_SIZE) return;
    const next = page[page.length - 1]?.id;
    if (!next || next === cursor) throw new Error('Analytics pagination cursor did not advance');
    cursor = next;
  }
}

export function analyticsStatusPolicy() {
  return { responseStatuses: [...RESPONSE_STATUSES], interviewStatuses: [...INTERVIEW_STATUSES], offerStatuses: [...OFFER_STATUSES] };
}

export function groupApplicationsByDateAndStatus(applications: Array<{ createdAt: Date; status: string }>) {
  const grouped = new Map<string, { date: string; total: number; statuses: Record<string, number> }>();
  for (const application of applications) {
    if (!application || !(application.createdAt instanceof Date) || !Number.isFinite(application.createdAt.getTime())
      || typeof application.status !== 'string' || !application.status.trim() || application.status.length > 100) continue;
    const date = application.createdAt.toISOString().slice(0, 10);
    const row = grouped.get(date) ?? { date, total: 0, statuses: {} };
    row.total += 1;
    row.statuses[application.status] = (row.statuses[application.status] ?? 0) + 1;
    grouped.set(date, row);
  }
  return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function classifyAtsScore(score: unknown): 'below60' | 'from60To79' | 'from80To89' | 'from90To100' | null {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return null;
  if (score < 60) return 'below60';
  if (score < 80) return 'from60To79';
  if (score < 90) return 'from80To89';
  return 'from90To100';
}

export function parseAnalyticsDays(value: unknown): number | null {
  if (value === undefined) return 30;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= 365 ? days : null;
}

export function averageElapsedHours(rows: Array<{ startedAt: Date | null; endedAt: Date | null }>): number {
  const durations = rows
    .filter(row => row && row.startedAt instanceof Date && Number.isFinite(row.startedAt.getTime())
      && row.endedAt instanceof Date && Number.isFinite(row.endedAt.getTime())
      && row.endedAt.getTime() >= row.startedAt.getTime())
    .map(row => row.endedAt!.getTime() - row.startedAt!.getTime());
  return durations.length ? durations.reduce((total, duration) => total + duration, 0) / durations.length / 3_600_000 : 0;
}

export function summarizeInterviewRounds(rows: Array<{ round: number }>) {
  const byRound: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.round) || row.round < 1 || row.round > 100) continue;
    total += 1;
    const key = String(row.round);
    byRound[key] = (byRound[key] ?? 0) + 1;
  }
  return { total, byRound, highestRound: Object.keys(byRound).reduce((highest, round) => Math.max(highest, Number(round)), 0) };
}

export function summarizeOfferOutcomes(rows: Array<{ status: string }>) {
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    if (!row || typeof row.status !== 'string' || !/^[A-Z_]{1,40}$/.test(row.status)) continue;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
}

export function applicationTimelineRows(grouped: Record<string, number>) {
  return Object.entries(grouped)
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

// GET /api/analytics/dashboard
router.get('/dashboard', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    return withTenant(userId, async prisma => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const [jobsDiscovered, qualifiedJobs, applicationsToday, applicationsWeek, applicationsMonth, totalApplications, interviews, responses, failed, pending, offers, rejected, confirmed] = await Promise.all([
      prisma.jobDiscoveryItem.count({ where: { userId } }),
      prisma.jobMatch.count({ where: { userId, overall: { gte: 80 } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: todayStart } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: weekStart } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: monthStart } } }),
      prisma.application.count({ where: { userId } }),
      prisma.application.count({ where: { userId, status: { in: [...INTERVIEW_STATUSES] } } }),
      prisma.application.count({ where: { userId, status: { in: [...RESPONSE_STATUSES] } } }),
      prisma.application.count({ where: { userId, status: 'FAILED' } }),
      prisma.application.count({ where: { userId, status: { in: ['DISCOVERED', 'QUALIFIED', 'RESUME_GENERATED', 'APPLICATION_STARTED', 'FORM_FILLED', 'WAITING_FOR_USER'] } } }),
      prisma.application.count({ where: { userId, status: { in: [...OFFER_STATUSES] } } }),
      prisma.application.count({ where: { userId, status: 'REJECTED' } }),
      prisma.application.count({ where: { userId, status: 'CONFIRMED' } }),
    ]);

    const interviewSummary = { total: 0, highestRound: 0, byRound: {} as Record<string, number> };
    await forEachAnalyticsPage(
      cursor => prisma.interview.findMany({ where: { userId }, select: { id: true, round: true }, orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      interview => {
        if (!Number.isSafeInteger(interview.round) || interview.round < 1 || interview.round > 100) return;
        interviewSummary.total += 1;
        interviewSummary.highestRound = Math.max(interviewSummary.highestRound, interview.round);
        const key = String(interview.round);
        interviewSummary.byRound[key] = (interviewSummary.byRound[key] ?? 0) + 1;
      },
    );
    const offerSummary = { total: 0, byStatus: {} as Record<string, number> };
    await forEachAnalyticsPage(
      cursor => prisma.offer.findMany({ where: { userId }, select: { id: true, status: true }, orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      offer => {
        if (!/^[A-Z_]{1,40}$/.test(offer.status)) return;
        offerSummary.total += 1;
        offerSummary.byStatus[offer.status] = (offerSummary.byStatus[offer.status] ?? 0) + 1;
      },
    );

    const matchScores = await prisma.jobMatch.aggregate({
      where: { userId },
      _avg: { overall: true },
    });

    const atsScores = await prisma.resumeVersion.aggregate({
      where: { resume: { userId } },
      _avg: { atsScoreOverall: true },
    });

    const lifecycleCounts = await prisma.application.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    });
    const providerMetrics: Record<string, { total: number; confirmed: number; failed: number; confirmedRate: number }> = {};
    const roleMetrics: Record<string, { total: number; confirmed: number; failed: number; confirmedRate: number }> = {};
    await forEachAnalyticsPage(
      cursor => prisma.application.findMany({
        where: { userId },
        select: { id: true, status: true, job: { select: { source: true, title: true } } },
        orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      application => {
      const source = application.job.source.trim().toUpperCase();
      const role = application.job.title.trim() || 'UNSPECIFIED';
      const metrics = [providerMetrics[source] ??= { total: 0, confirmed: 0, failed: 0, confirmedRate: 0 }, roleMetrics[role] ??= { total: 0, confirmed: 0, failed: 0, confirmedRate: 0 }];
      for (const metric of metrics) {
        metric.total += 1;
        if (application.status === 'CONFIRMED') metric.confirmed += 1;
        if (application.status === 'FAILED') metric.failed += 1;
        metric.confirmedRate = metric.total > 0 ? metric.confirmed / metric.total * 100 : 0;
      }
      },
    );
    const failureRows = await prisma.failureRecord.groupBy({ by: ['code'], where: { userId }, _count: { _all: true } });
    let submissionDurationCount = 0;
    let submissionDurationTotalMs = 0;
    await forEachAnalyticsPage(
      cursor => prisma.applicationAttempt.findMany({
        where: { application: { userId }, status: { in: ['UNCONFIRMED', 'CONFIRMED'] }, completedAt: { not: null } },
        select: { id: true, startedAt: true, completedAt: true }, orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      attempt => {
        if (!(attempt.startedAt instanceof Date) || !Number.isFinite(attempt.startedAt.getTime())
          || !(attempt.completedAt instanceof Date) || !Number.isFinite(attempt.completedAt.getTime())
          || attempt.completedAt.getTime() < attempt.startedAt.getTime()) return;
        submissionDurationCount += 1;
        submissionDurationTotalMs += attempt.completedAt.getTime() - attempt.startedAt.getTime();
      },
    );
    const failureReasons = Object.fromEntries(failureRows.map(row => [row.code, row._count._all]));
    const resumeVersionPerformance: Record<string, { applications: number; confirmed: number; failed: number }> = {};
    await forEachAnalyticsPage(
      cursor => prisma.application.findMany({
        where: { userId },
        select: { id: true, resumeVersionId: true, status: true },
        orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      application => {
        const metric = resumeVersionPerformance[application.resumeVersionId] ??= { applications: 0, confirmed: 0, failed: 0 };
        metric.applications += 1;
        if (application.status === 'CONFIRMED') metric.confirmed += 1;
        if (application.status === 'FAILED') metric.failed += 1;
      },
    );
    const atsScoreDistribution = { below60: 0, from60To79: 0, from80To89: 0, from90To100: 0 };
    const confirmationDurations: number[] = [];
    await forEachAnalyticsPage(
      cursor => prisma.application.findMany({
        where: { userId },
        select: { id: true, atsScore: true, createdAt: true, appliedAt: true, confirmedAt: true },
        orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      application => {
      const atsBucket = classifyAtsScore(application.atsScore);
      if (atsBucket) atsScoreDistribution[atsBucket] += 1;
      if (application.appliedAt && application.confirmedAt && application.confirmedAt >= application.appliedAt) {
        confirmationDurations.push(application.confirmedAt.getTime() - application.appliedAt.getTime());
      }
      },
    );

    return res.json({
      success: true,
      data: {
        jobsDiscovered,
        qualifiedJobs,
        applicationsToday,
        applicationsThisWeek: applicationsWeek,
        applicationsThisMonth: applicationsMonth,
        interviewRate: totalApplications > 0 ? (interviews / totalApplications * 100) : 0,
        responseRate: totalApplications > 0 ? (responses / totalApplications * 100) : 0,
        offerRate: totalApplications > 0 ? (offers / totalApplications * 100) : 0,
        rejectionRate: totalApplications > 0 ? (rejected / totalApplications * 100) : 0,
        submissionSuccessRate: totalApplications > 0 ? (confirmed / totalApplications * 100) : 0,
        averageMatchScore: matchScores._avg.overall || 0,
        averageATSScore: atsScores._avg.atsScoreOverall || 0,
        pendingApplications: pending,
        failedApplications: failed,
        lifecycleCounts: Object.fromEntries(lifecycleCounts.map((row) => [row.status, row._count._all])),
        providerMetrics,
        roleMetrics,
        failureReasons,
        resumeVersionPerformance,
        atsScoreDistribution,
        averageTimeToConfirmationHours: confirmationDurations.length
          ? confirmationDurations.reduce((total, duration) => total + duration, 0) / confirmationDurations.length / 3_600_000
          : 0,
        averageTimeToSubmissionHours: submissionDurationCount ? submissionDurationTotalMs / submissionDurationCount / 3_600_000 : 0,
        interviewRounds: interviewSummary,
        offerOutcomes: offerSummary,
      },
    });
    });
  } catch (error) {
    logRouteError('analytics.dashboard_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// GET /api/analytics/applications-over-time
router.get('/applications-over-time', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsedDays = parseAnalyticsDays(req.query.days);
    if (parsedDays === null) {
      return res.status(400).json({ success: false, error: 'days must be an integer between 1 and 365' });
    }
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parsedDays);

    return withTenant(req.user!.userId, async prisma => {
    const grouped: Record<string, number> = {};
    await forEachAnalyticsPage(
      cursor => prisma.application.findMany({
        where: { userId: req.user!.userId, createdAt: { gte: startDate } },
        select: { id: true, createdAt: true, status: true },
        orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      app => {
        const date = app.createdAt.toISOString().split('T')[0]!;
        grouped[date] = (grouped[date] || 0) + 1;
      },
    );

    const data = applicationTimelineRows(grouped);

    return res.json({ success: true, data });
    });
  } catch (error) {
    logRouteError('analytics.timeline_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch data' });
  }
});

// GET /api/analytics/applications-funnel: historical lifecycle counts, scoped to the authenticated tenant.
router.get('/applications-funnel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsedDays = parseAnalyticsDays(req.query.days);
    if (parsedDays === null) return res.status(400).json({ success: false, error: 'days must be an integer between 1 and 365' });
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parsedDays);
    return withTenant(req.user!.userId, async prisma => {
    const grouped = new Map<string, { date: string; total: number; statuses: Record<string, number> }>();
    await forEachAnalyticsPage(
      cursor => prisma.application.findMany({
        where: { userId: req.user!.userId, createdAt: { gte: startDate } },
        select: { id: true, createdAt: true, status: true },
        orderBy: { id: 'asc' }, take: ANALYTICS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      application => {
        const date = application.createdAt.toISOString().slice(0, 10);
        const row = grouped.get(date) ?? { date, total: 0, statuses: {} };
        row.total += 1;
        row.statuses[application.status] = (row.statuses[application.status] ?? 0) + 1;
        grouped.set(date, row);
      },
    );
    return res.json({ success: true, data: [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date)) });
    });
  } catch (error) {
    logRouteError('analytics.funnel_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch application funnel' });
  }
});

export { router as analyticsRoutes };
