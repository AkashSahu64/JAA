import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Store active connections
const clients = new Map<string, Response[]>();

// GET /api/sse/events - SSE endpoint
router.get('/events', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.userId;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  
  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  
  // Add client
  const userClients = clients.get(userId) || [];
  userClients.push(res);
  clients.set(userId, userClients);
  
  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);
  
  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    const remaining = (clients.get(userId) || []).filter(c => c !== res);
    if (remaining.length > 0) {
      clients.set(userId, remaining);
    } else {
      clients.delete(userId);
    }
  });
});

// Broadcast to user
export function broadcastToUser(userId: string, event: { type: string; data: unknown }): void {
  const userClients = clients.get(userId) || [];
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of userClients) {
    try {
      client.write(message);
    } catch {
      client.end();
      const remaining = (clients.get(userId) || []).filter(c => c !== client);
      if (remaining.length) clients.set(userId, remaining);
      else clients.delete(userId);
    }
  }
}

export { router as sseRoutes };
