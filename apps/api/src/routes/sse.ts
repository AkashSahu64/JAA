import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

export type LiveEvent = { type: string; data: unknown; id?: string };
type LiveClient = { response: Response; replaying: boolean; pending: LiveEvent[] };
const clients = new Map<string, LiveClient[]>();
const MAX_PENDING_EVENTS = 1_000;
const MAX_EVENT_BYTES = 100_000;
export const MAX_SSE_CONNECTIONS_PER_USER = 10;
export const SSE_RESPONSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export function hasSseCapacity(currentConnections: number, maxConnections = MAX_SSE_CONNECTIONS_PER_USER): boolean {
  return Number.isSafeInteger(currentConnections) && currentConnections >= 0
    && Number.isSafeInteger(maxConnections) && maxConnections > 0 && currentConnections < maxConnections;
}

export function serializeSseData(data: unknown): string | null {
  try {
    const serialized = JSON.stringify(data);
    return serialized && serialized.length <= MAX_EVENT_BYTES ? serialized : null;
  } catch {
    return null;
  }
}

export function isSafeSseToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !value.split('').some(character => character === '\r' || character === '\n' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/**
 * A notification can be committed and broadcast while a client is replaying
 * its durable cursor. Do not emit that same durable event twice when flushing
 * the live queue after replay. Events without an id remain deliverable because
 * they cannot be correlated with a durable replay record.
 */
export function deduplicateReplayedEvents(replayedIds: ReadonlySet<string>, pending: readonly LiveEvent[]): LiveEvent[] {
  const seen = new Set(replayedIds);
  const result: LiveEvent[] = [];
  for (const event of pending) {
    if (event.id !== undefined) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    result.push(event);
  }
  return result;
}

export function shouldPruneSseClient(writableEnded: unknown): boolean {
  return writableEnded === true;
}

/** Keep a broken client from turning a heartbeat write into an uncaught process error. */
export function writeSseHeartbeat(response: Pick<Response, 'write' | 'writableEnded'>): boolean {
  if (response.writableEnded) return false;
  try {
    response.write(': heartbeat\n\n');
    return true;
  } catch {
    return false;
  }
}

function removeClient(userId: string, client: LiveClient): void {
  const remaining = (clients.get(userId) || []).filter(candidate => candidate !== client);
  if (remaining.length) clients.set(userId, remaining);
  else clients.delete(userId);
}

// GET /api/sse/events - SSE endpoint
router.get('/events', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.userId;
  if (!hasSseCapacity(clients.get(userId)?.length ?? 0)) {
    return res.status(429).json({ success: false, error: 'Too many live event connections' });
  }
  
  res.writeHead(200, SSE_RESPONSE_HEADERS);
  res.flushHeaders();
  
  const writeEvent = (id: string | undefined, type: string, data: unknown) => {
    if (res.writableEnded) return;
    if (!isSafeSseToken(type) || (id !== undefined && !isSafeSseToken(id))) {
      res.end();
      removeClient(userId, client);
      return;
    }
    const serialized = serializeSseData(data);
    if (!serialized) {
      res.end();
      removeClient(userId, client);
      return;
    }
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${type}\ndata: ${serialized}\n\n`);
  };
  const client: LiveClient = { response: res, replaying: true, pending: [] };
  const userClients = clients.get(userId) || [];
  userClients.push(client);
  clients.set(userId, userClients);

  // Replay durable notifications before registering live delivery. The cursor
  // is resolved only inside this tenant's notification scope.
  let replayFailed = false;
  void (async () => {
    try {
      const notifications = await withTenant(userId, async tx => {
        const lastEventId = req.get('Last-Event-ID')?.trim();
        const cursor = lastEventId
          ? await tx.notification.findFirst({ where: { id: lastEventId, userId }, select: { id: true, createdAt: true } })
          : null;
        return tx.notification.findMany({
          where: { userId, ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}) },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 100,
        });
      });
      const replayedIds = new Set<string>();
      writeEvent(undefined, 'connected', { timestamp: new Date().toISOString(), replayed: notifications.length });
      for (const notification of notifications) {
        replayedIds.add(notification.id);
        writeEvent(notification.id, 'notification', notification);
      }
      const pending = deduplicateReplayedEvents(replayedIds, client.pending.splice(0));
      for (const event of pending) writeEvent(event.id, event.type, event.data);
    } catch {
      // A live-only stream is unsafe: notifications committed during a replay
      // failure could be missed across reconnects. Close the stream and let the
      // client retry with its Last-Event-ID once durable replay is available.
      replayFailed = true;
      client.pending.length = 0;
      writeEvent(undefined, 'error', { code: 'REPLAY_UNAVAILABLE', retryable: true });
      res.end();
      removeClient(userId, client);
    } finally {
      client.replaying = false;
      if (!replayFailed) {
        const pending = client.pending.splice(0);
        for (const event of pending) writeEvent(event.id, event.type, event.data);
      }
    }
  })();
  
  // Heartbeat
  const heartbeat = setInterval(() => {
    if (!writeSseHeartbeat(res)) {
      if (!res.writableEnded) res.end();
      removeClient(userId, client);
    }
  }, 30000);
  
  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(userId, client);
  });
  return undefined;
});

// Broadcast to user
export function broadcastToUser(userId: string, event: { id?: string; type: string; data: unknown }): void {
  const userClients = clients.get(userId) || [];
  for (const client of userClients) {
    try {
      if (!isSafeSseToken(event.type) || (event.id !== undefined && !isSafeSseToken(event.id))) {
        client.response.end();
        removeClient(userId, client);
        continue;
      }
      if (client.replaying) {
        if (client.pending.length >= MAX_PENDING_EVENTS) {
          client.response.end();
          removeClient(userId, client);
          continue;
        }
        client.pending.push(event);
        continue;
      }
      if (shouldPruneSseClient(client.response.writableEnded)) {
        removeClient(userId, client);
        continue;
      }
      const serialized = serializeSseData(event.data);
      if (!serialized) {
        client.response.end();
        removeClient(userId, client);
        continue;
      }
      if (event.id) client.response.write(`id: ${event.id}\n`);
      client.response.write(`event: ${event.type}\ndata: ${serialized}\n\n`);
    } catch {
      client.response.end();
      removeClient(userId, client);
    }
  }
}

export { router as sseRoutes };
