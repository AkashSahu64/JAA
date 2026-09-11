import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const where: any = { userId: req.user!.userId };
    if (unreadOnly) where.read = false;
    
    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ success: true, data: notifications });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

router.patch('/:id/read', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notification = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.userId },
      data: { read: true },
    });
    if (notification.count === 0) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    return res.json({ success: true, data: { id: req.params.id, read: true } });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

router.post('/mark-all-read', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.userId, read: false },
      data: { read: true },
    });
    return res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to mark notifications' });
  }
});

export { router as notificationRoutes };
