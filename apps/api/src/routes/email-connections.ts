import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { EMAIL_PROVIDERS, grantEmailConsent, revokeEmailConsent } from '../services/email-connections';
import { createEmailOAuthAuthorization, exchangeEmailOAuthCode } from '../services/email-oauth';
import { logRouteError } from '../observability/structured-log';
import { safeEmailErrorMessage } from '../services/email-errors';

const router = Router();
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

router.get('/oauth/callback', async (req: AuthenticatedRequest, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  try {
    const result = await exchangeEmailOAuthCode({ userId: req.user!.userId, state, code });
    return res.json({ success: true, data: { id: result.connection.id, provider: result.provider, status: result.connection.status } });
  } catch (error) {
    logRouteError('email_connections.oauth_callback_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(400).json({ success: false, error: safeEmailErrorMessage(error, 'OAuth callback failed') });
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
