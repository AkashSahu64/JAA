import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { EMAIL_PROVIDERS, grantEmailConsent, revokeEmailConsent } from '../services/email-connections';
import { createEmailOAuthAuthorization, exchangeEmailOAuthCode } from '../services/email-oauth';
import { logRouteError } from '../observability/structured-log';
import { safeEmailErrorMessage } from '../services/email-errors';
import { createAutomationJob } from '../services/automation-jobs';
import { normalizeCorrelationId } from '../middleware/request-logger';

const router = Router();

// OAuth providers redirect without the application's Bearer header. The opaque, single-use
// state is the only capability used to identify the owner; exchange and persistence remain
// tenant-scoped inside the service layer.
router.get('/oauth/callback', async (req: AuthenticatedRequest, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  try {
    const result = await exchangeEmailOAuthCode({ state, code });
    return res.json({ success: true, data: { id: result.connection.id, provider: result.provider, status: result.connection.status } });
  } catch (error) {
    logRouteError('email_connections.oauth_callback_failure', error, { correlationId: req.get('x-correlation-id') });
    return res.status(400).json({ success: false, error: safeEmailErrorMessage(error, 'OAuth callback failed') });
  }
});

router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const connections = await withTenant(req.user!.userId, async prisma => prisma.emailConnection.findMany({ where: { userId: req.user!.userId }, select: { id: true, provider: true, accountLabel: true, scopes: true, status: true, grantedAt: true, revokedAt: true, lastSyncAt: true }, orderBy: { createdAt: 'desc' } }));
    return res.json({ success: true, data: connections });
  } catch (error) {
    logRouteError('email_connections.list_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch email connections' });
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const provider = req.body?.provider;
  const accountLabel = typeof req.body?.accountLabel === 'string' ? req.body.accountLabel.trim() : '';
  const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
  const credentialRef = typeof req.body?.credentialRef === 'string' ? req.body.credentialRef.trim() : undefined;
  if (!EMAIL_PROVIDERS.includes(provider) || !accountLabel || !Array.isArray(scopes)) return res.status(400).json({ success: false, error: 'provider, accountLabel, and scopes are required' });
  try {
    const connection = await grantEmailConsent({ userId: req.user!.userId, provider, accountLabel, scopes, credentialRef });
    return res.status(201).json({ success: true, data: { id: connection.id, provider: connection.provider, accountLabel: connection.accountLabel, scopes: connection.scopes, status: connection.status } });
  } catch (error) {
    logRouteError('email_connections.grant_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(400).json({ success: false, error: safeEmailErrorMessage(error, 'Invalid email consent') });
  }
});

router.post('/oauth/start', async (req: AuthenticatedRequest, res: Response) => {
  const provider = req.body?.provider;
  const redirectUri = typeof req.body?.redirectUri === 'string' ? req.body.redirectUri : '';
  const accountLabel = typeof req.body?.accountLabel === 'string' ? req.body.accountLabel : '';
  const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
  try {
    const result = await createEmailOAuthAuthorization({ userId: req.user!.userId, provider, redirectUri, accountLabel, scopes });
    return res.status(201).json({ success: true, data: { authorizationUrl: result.authorizationUrl, stateId: result.stateId, expiresAt: result.expiresAt } });
  } catch (error) {
    logRouteError('email_connections.oauth_start_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(400).json({ success: false, error: safeEmailErrorMessage(error, 'Invalid OAuth authorization request') });
  }
});

router.post('/:id/sync', async (req: AuthenticatedRequest, res: Response) => {
  const connectionId = req.params.id;
  const idempotencyKey = req.header('idempotency-key');
  if (typeof connectionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(connectionId)
    || typeof idempotencyKey !== 'string' || !/^[\x21-\x7E]{16,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ success: false, error: 'Idempotency-Key must be 16-128 printable characters' });
  }
  try {
    const connection = await withTenant(req.user!.userId, async tx => tx.emailConnection.findFirst({
      where: { id: connectionId, userId: req.user!.userId, status: 'ACTIVE' },
      select: { id: true, provider: true },
    }));
    if (!connection) return res.status(404).json({ success: false, error: 'Active email connection not found' });
    if (connection.provider !== 'GMAIL' && connection.provider !== 'MICROSOFT_GRAPH') return res.status(400).json({ success: false, error: 'This email provider cannot be synchronized' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      type: 'SYNC_EMAIL_CONNECTION',
      payload: { connectionId: connection.id, provider: connection.provider },
      correlationId: normalizeCorrelationId(req.get('x-correlation-id')),
      idempotencyKey: `email-sync:${req.user!.userId}:${connection.id}:${idempotencyKey}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch (error) {
    logRouteError('email_connections.sync_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to queue email synchronization' });
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const connection = await revokeEmailConsent(req.user!.userId, req.params.id.trim());
    return res.json({ success: true, data: { id: connection.id, status: connection.status, revokedAt: connection.revokedAt } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    logRouteError('email_connections.revoke_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(message.includes('not found') ? 404 : 400).json({ success: false, error: safeEmailErrorMessage(error, 'Failed to revoke email consent') });
  }
});

export { router as emailConnectionRoutes };
