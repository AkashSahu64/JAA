import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profile';
import { jobRoutes } from './routes/jobs';
import { resumeRoutes } from './routes/resumes';
import { applicationRoutes } from './routes/applications';
import { automationRoutes } from './routes/automation';
import { analyticsRoutes } from './routes/analytics';
import { searchProfileRoutes } from './routes/search-profiles';
import { notificationRoutes } from './routes/notifications';
import { humanVerificationRoutes } from './routes/human-verifications';
import { ruleRoutes } from './routes/rules';
import { sseRoutes } from './routes/sse';
import { aiRoutes } from './routes/ai';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { prisma } from '@jobagent/database';
import { emailOutcomeRoutes } from './routes/email-outcomes';
import { emailConnectionRoutes } from './routes/email-connections';
import { documentRoutes } from './routes/documents';
import { logRouteError, writeStructuredLog } from './observability/structured-log';

export function apiPrivacyHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 25, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use('/api', apiPrivacyHeaders);
  app.use(requestLogger);
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/resumes', resumeRoutes);
  app.use('/api/applications', applicationRoutes);
  app.use('/api/automation', automationRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/search-profiles', searchProfileRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/human-verifications', humanVerificationRoutes);
  app.use('/api/rules', ruleRoutes);
  app.use('/api/sse', sseRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/email-outcomes', emailOutcomeRoutes);
  app.use('/api/email-connections', emailConnectionRoutes);
  app.use('/api/documents', documentRoutes);
  app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/api/ready', async (_, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.json({ status: 'ready', checks: { database: 'ok' }, timestamp: new Date().toISOString() });
    } catch (error) {
      logRouteError('api.readiness_failure', error, { correlationId: _.get('x-correlation-id') });
      return res.status(503).json({ status: 'not_ready', checks: { database: 'unavailable' }, timestamp: new Date().toISOString() });
    }
  });
  app.use((req, res) => {
    writeStructuredLog('warn', { event: 'http.route_not_found', correlationId: req.get('x-correlation-id'), method: req.method, path: req.path });
    res.status(404).json({ success: false, error: 'Route not found' });
  });
  app.use(errorHandler);
  return app;
}
