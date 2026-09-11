import { Router, Request, Response } from 'express';
import { prisma } from '@jobagent/database';
import { hashPassword, verifyPassword, generateToken, generateRefreshToken, verifyRefreshToken, isValidEmail } from '@jobagent/security';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

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
    return res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token: generateToken({ userId: user.id, email: user.email }),
        refreshToken: generateRefreshToken({ userId: user.id, email: user.email }),
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
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
    return res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token: generateToken({ userId: user.id, email: user.email }),
        refreshToken: generateRefreshToken({ userId: user.id, email: user.email }),
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

router.post('/refresh', validateBody({ refreshToken: { type: 'string', required: true, minLength: 1, maxLength: 4096 } }), (req: Request, res: Response) => {
  try {
    const payload = verifyRefreshToken(req.body.refreshToken);
    return res.json({
      success: true,
      data: {
        token: generateToken(payload),
        refreshToken: generateRefreshToken(payload),
      },
    });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
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
    console.error('Current user error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

export { router as authRoutes };
