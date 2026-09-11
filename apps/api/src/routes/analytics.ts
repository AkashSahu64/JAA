import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/analytics/dashboard
router.get('/dashboard', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const [jobsDiscovered, qualifiedJobs, applicationsToday, applicationsWeek, applicationsMonth, totalApplications, interviews, responses, failed, pending] = await Promise.all([
      prisma.job.count({ where: { isActive: true } }),
      prisma.jobMatch.count({ where: { userId, overall: { gte: 80 } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: todayStart } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: weekStart } } }),
      prisma.application.count({ where: { userId, appliedAt: { gte: monthStart } } }),
      prisma.application.count({ where: { userId } }),
      prisma.application.count({ where: { userId, status: 'INTERVIEW' } }),
      prisma.application.count({ where: { userId, status: { in: ['INTERVIEW', 'OFFER', 'CONFIRMED'] } } }),
      prisma.application.count({ where: { userId, status: 'FAILED' } }),
      prisma.application.count({ where: { userId, status: { in: ['DISCOVERED', 'QUALIFIED', 'RESUME_GENERATED', 'APPLICATION_STARTED', 'FORM_FILLED', 'WAITING_FOR_USER'] } } }),
    ]);

    const matchScores = await prisma.jobMatch.aggregate({
      where: { userId },
      _avg: { overall: true },
    });

    const atsScores = await prisma.resumeVersion.aggregate({
      where: { resume: { userId } },
      _avg: { atsScoreOverall: true },
    });

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
        averageMatchScore: matchScores._avg.overall || 0,
        averageATSScore: atsScores._avg.atsScoreOverall || 0,
        pendingApplications: pending,
        failedApplications: failed,
      },
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// GET /api/analytics/applications-over-time
router.get('/applications-over-time', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsedDays = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
      return res.status(400).json({ success: false, error: 'days must be an integer between 1 and 365' });
    }
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parsedDays);

    const applications = await prisma.application.findMany({
      where: {
        userId: req.user!.userId,
        createdAt: { gte: startDate },
      },
      select: { createdAt: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by date
    const grouped: Record<string, number> = {};
    for (const app of applications) {
      const date = app.createdAt.toISOString().split('T')[0];
      grouped[date] = (grouped[date] || 0) + 1;
    }

    const data = Object.entries(grouped).map(([date, count]) => ({ date, count }));

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch data' });
  }
});

export { router as analyticsRoutes };
