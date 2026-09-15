import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { applyEmailOutcome, ingestEmailOutcome, linkEmailOutcome, reviewEmailOutcome } from '../services/email-outcomes';
import { logRouteError } from '../observability/structured-log';
import { safeEmailErrorMessage } from '../services/email-errors';

const router = Router();
router.use(authenticate);

function text(value: unknown, max = 2_000_000): string {
  return typeof value === 'string' && value.length <= max ? value.trim() : '';
}

export function createEmailOutcomeInput(userId: string, body: Record<string, unknown>) {
  const messageId = text(body.messageId, 512);
  const sender = text(body.sender, 512);
  const subject = text(body.subject, 20_000);
  const emailBody = text(body.body, 2_000_000);
  const receivedAt = typeof body.receivedAt === 'string' ? new Date(body.receivedAt) : new Date(NaN);
  const applicationId = body.applicationId === undefined ? undefined : text(body.applicationId, 200);
  if (!userId || !messageId || !sender || !subject || !emailBody || !Number.isFinite(receivedAt.getTime()) || (body.applicationId !== undefined && !applicationId)) return null;
  return { userId, messageId, sender, subject, body: emailBody, receivedAt, applicationId };
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const outcomes = await withTenant(req.user!.userId, async prisma => prisma.emailOutcome.findMany({
      where: { userId: req.user!.userId },
      // Review state is durable workflow data; raw message hashes/evidence are
      // intentionally not returned from this general listing surface.
      select: { id: true, applicationId: true, source: true, messageId: true, classification: true, confidence: true, reviewedAt: true, reviewedBy: true, receivedAt: true, createdAt: true },
      orderBy: { receivedAt: 'desc' }, take: 100,
    }));
    return res.json({ success: true, data: outcomes });
  } catch (error) {
    logRouteError('email_outcomes.list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch email outcomes' });
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const input = createEmailOutcomeInput(req.user!.userId, req.body ?? {});
  if (!input) return res.status(400).json({ success: false, error: 'messageId, sender, subject, body, and valid receivedAt are required' });
  try {
    const outcome = await ingestEmailOutcome(input);
    return res.status(202).json({ success: true, data: { id: outcome.id, classification: outcome.classification, confidence: outcome.confidence, applicationId: outcome.applicationId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Application not found' });
    if (message.includes('Invalid email') || message.includes('exceeds')) return res.status(400).json({ success: false, error: 'Invalid email message' });
    logRouteError('email_outcomes.ingest_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: input.applicationId });
    return res.status(500).json({ success: false, error: 'Failed to ingest email outcome' });
  }
});

router.patch('/:id/link', async (req: AuthenticatedRequest, res: Response) => {
  const applicationId = req.body?.applicationId === null ? null : text(req.body?.applicationId, 200);
  if (req.body?.applicationId !== null && !applicationId) return res.status(400).json({ success: false, error: 'applicationId must be a non-empty identifier or null' });
  try {
    const outcome = await linkEmailOutcome(req.user!.userId, req.params.id.trim(), applicationId ?? null);
    return res.json({ success: true, data: { id: outcome.id, applicationId: outcome.applicationId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('not found') || message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Email outcome or application not found' });
    logRouteError('email_outcomes.link_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId, applicationId: applicationId ?? undefined });
    return res.status(400).json({ success: false, error: safeEmailErrorMessage(error, 'Failed to link email outcome') });
  }
});

router.post('/:id/review', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const outcome = await reviewEmailOutcome(req.user!.userId, req.params.id.trim());
    return res.json({ success: true, data: { id: outcome.id, applicationId: outcome.applicationId, reviewedAt: outcome.reviewedAt, reviewedBy: outcome.reviewedBy } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('not found') || message.includes('does not belong')) return res.status(404).json({ success: false, error: 'Email outcome not found' });
    logRouteError('email_outcomes.review_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(409).json({ success: false, error: safeEmailErrorMessage(error, 'Failed to review email outcome') });
  }
});

router.post('/:id/apply', async (req: AuthenticatedRequest, res: Response) => {
  const expectedVersion = req.body?.expectedVersion;
  const idempotencyKey = text(req.get('Idempotency-Key'), 200);
  const correlationId = text(req.body?.correlationId, 200);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !idempotencyKey || !correlationId) {
    return res.status(400).json({ success: false, error: 'expectedVersion, Idempotency-Key, and correlationId are required' });
  }
  try {
    const result = await applyEmailOutcome({ userId: req.user!.userId, outcomeId: req.params.id.trim(), expectedVersion, idempotencyKey, correlationId });
    return res.json({ success: true, data: { outcomeId: result.outcomeId, target: result.target, application: result.application }, replayed: result.replayed });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('not found')) return res.status(404).json({ success: false, error: 'Email outcome not found' });
    if (message.includes('required') || message.includes('actionable')) return res.status(409).json({ success: false, error: safeEmailErrorMessage(error, 'Email outcome cannot be applied') });
    logRouteError('email_outcomes.apply_failure', error, { correlationId, userId: req.user?.userId, applicationId: req.params.id });
    return res.status(422).json({ success: false, error: safeEmailErrorMessage(error, 'Failed to apply email outcome') });
  }
});

export { router as emailOutcomeRoutes };
