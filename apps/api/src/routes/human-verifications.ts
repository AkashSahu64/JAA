import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import {
  cancelHumanVerification,
  HumanVerificationError,
  resolveHumanVerification,
} from '../services/human-verification';

const router = Router();
router.use(authenticate);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function correlationId(req: AuthenticatedRequest, verificationId: string): string {
  return text(req.body?.correlationId) || `human-verification:${req.user!.userId}:${verificationId}`;
}

function errorStatus(error: HumanVerificationError): number {
  if (error.code === 'INVALID') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'EXPIRED') return 410;
  return 409;
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const verifications = await prisma.humanVerification.findMany({
      where: { userId: req.user!.userId, ...(status ? { status } : {}) },
      select: {
        id: true, applicationId: true, type: true, status: true, prompt: true, context: true,
        expiresAt: true, resolvedAt: true, resolution: true, resumeToStatus: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ success: true, data: verifications });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch human verifications' });
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const verification = await prisma.humanVerification.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: {
        id: true, applicationId: true, type: true, status: true, prompt: true, context: true,
        expiresAt: true, resolvedAt: true, resolution: true, resumeToStatus: true, createdAt: true, updatedAt: true,
      },
    });
    if (!verification) return res.status(404).json({ success: false, error: 'Human verification not found' });
    return res.json({ success: true, data: verification });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch human verification' });
  }
});

router.post('/:id/resolve', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const verificationId = text(req.params.id);
    if (!verificationId) return res.status(400).json({ success: false, error: 'Verification identifier is required' });
    const result = await resolveHumanVerification({
      userId: req.user!.userId,
      verificationId,
      correlationId: correlationId(req, verificationId),
    });
    return res.status(result.replayed ? 200 : 202).json({
      success: true,
      data: { verification: result.verification, automationJob: result.resumeJob, replayed: result.replayed },
    });
  } catch (error) {
    if (error instanceof HumanVerificationError) {
      return res.status(errorStatus(error)).json({ success: false, error: error.message, code: error.code });
    }
    return res.status(500).json({ success: false, error: 'Failed to resolve human verification' });
  }
});

router.post('/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const verificationId = text(req.params.id);
    if (!verificationId) return res.status(400).json({ success: false, error: 'Verification identifier is required' });
    const result = await cancelHumanVerification({
      userId: req.user!.userId,
      verificationId,
      correlationId: correlationId(req, verificationId),
    });
    return res.json({ success: true, data: { verification: result.verification, replayed: result.replayed } });
  } catch (error) {
    if (error instanceof HumanVerificationError) {
      return res.status(errorStatus(error)).json({ success: false, error: error.message, code: error.code });
    }
    return res.status(500).json({ success: false, error: 'Failed to cancel human verification' });
  }
});

export { router as humanVerificationRoutes };
