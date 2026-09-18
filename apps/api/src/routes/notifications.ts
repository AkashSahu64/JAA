import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const NOTIFICATION_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 256;

type NotificationCursor = { createdAt: Date; id: string };

function encodeNotificationCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeNotificationCursor(value: unknown): NotificationCursor | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string'
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(parsed.id)) return null;
    const createdAt = new Date(parsed.createdAt);
    return Number.isFinite(createdAt.getTime()) ? { createdAt, id: parsed.id } : null;
  } catch {
    return null;
  }
}
router.use(authenticate);
// Notifications contain tenant-owned application and lifecycle data; never let
// a browser, proxy, or shared cache retain them beyond the authenticated request.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const cursorValue = req.query.before;
    const cursor = cursorValue === undefined ? null : decodeNotificationCursor(cursorValue);
    if (cursorValue !== undefined && !cursor) return res.status(400).json({ success: false, error: 'Invalid notification cursor' });
    const where: any = { userId: req.user!.userId };
    if (unreadOnly) where.read = false;
    if (cursor) where.OR = [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }];
    
    const notifications = await withTenant(req.user!.userId, tx => tx.notification.findMany({
      where,
      // Match the composite cursor predicate so equal-timestamp rows have a
      // deterministic order and cannot repeat or disappear between pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: NOTIFICATION_PAGE_SIZE + 1,
    }));
    const hasMore = notifications.length > NOTIFICATION_PAGE_SIZE;
    const page = hasMore ? notifications.slice(0, NOTIFICATION_PAGE_SIZE) : notifications;
    if (hasMore) {
      const last = page[page.length - 1];
      res.setHeader('X-Next-Notification-Cursor', encodeNotificationCursor(last.createdAt, last.id));
    }
    return res.json({ success: true, data: page, nextCursor: hasMore ? encodeNotificationCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

router.patch('/:id/read', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notification = await withTenant(req.user!.userId, tx => tx.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.userId },
      data: { read: true },
    }));
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
    await withTenant(req.user!.userId, tx => tx.notification.updateMany({
      where: { userId: req.user!.userId, read: false },
      data: { read: true },
    }));
    return res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to mark notifications' });
  }
});

export { router as notificationRoutes };
