import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma, withTenant } from '@jobagent/database';
import { hashPassword, verifyPassword, generateToken, generateRefreshToken, isValidEmail } from '@jobagent/security';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { logRouteError } from '../observability/structured-log';
import { RefreshSessionError, refreshTokenHash, revokeRefreshSessionFamily, rotateRefreshSession } from '../services/refresh-sessions';

const router = Router();
const loginCredentialsSchema = {
  email: { type: 'string', required: true, maxLength: 320 },
  password: { type: 'string', required: true, minLength: 1, maxLength: 1024 },
} as const;
const registrationSchema = {
  ...loginCredentialsSchema,
  password: { ...loginCredentialsSchema.password, minLength: 12 },
  name: { type: 'string', required: true, minLength: 1, maxLength: 200 },
} as const;

async function issueTokens(user: { id: string; email: string }) {
  const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
  await withTenant(user.id, async tx => {
    await tx.refreshTokenSession.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash(refreshToken),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  });
  return { token: generateToken({ userId: user.id, email: user.email }), refreshToken };
}

router.post('/register', validateBody(registrationSchema), async (req: Request, res: Response) => {
  try {
    const email = req.body.email.trim().toLowerCase();
    const name = req.body.name.trim();
    const password = req.body.password;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email format' });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ success: false, error: 'Email already registered' });

    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), name } });
    const tokens = await issueTokens(user);
    return res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        ...tokens,
      },
    });
  } catch (error) {
    logRouteError('auth.registration_failure', error, { correlationId: req.get('x-correlation-id') });
    return res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

router.post('/login', validateBody(loginCredentialsSchema), async (req: Request, res: Response) => {
  try {
    const email = req.body.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !(await verifyPassword(req.body.password, user.passwordHash))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await issueTokens(user);
    return res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        ...tokens,
      },
    });
  } catch (error) {
    logRouteError('auth.login_failure', error, { correlationId: req.get('x-correlation-id') });
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

router.post('/refresh', validateBody({ refreshToken: { type: 'string', required: true, minLength: 1, maxLength: 4096 } }), async (req: Request, res: Response) => {
  try {
    const tokens = await rotateRefreshSession(req.body.refreshToken as string);
    return res.json({ success: true, data: tokens });
  } catch (error) {
    if (error instanceof RefreshSessionError) return res.status(401).json({ success: false, error: error.message });
    logRouteError('auth.refresh_failure', error, { correlationId: req.get('x-correlation-id') });
    return res.status(503).json({ success: false, error: 'Refresh temporarily unavailable' });
  }
});

router.post('/logout', authenticate, validateBody({ refreshToken: { type: 'string', required: true, minLength: 1, maxLength: 4096 } }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await revokeRefreshSessionFamily(req.user!.userId, req.body.refreshToken as string);
    return res.json({ success: true, data: { revoked: true } });
  } catch {
    return res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

router.get('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.user!.userId, isActive: true },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid user' });
    return res.json({ success: true, data: user });
  } catch (error) {
    logRouteError('auth.current_user_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

export { router as authRoutes };
