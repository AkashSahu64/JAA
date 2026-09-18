import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn() }));

vi.mock('@jobagent/database', () => ({
  withTenant: vi.fn((_userId: string, callback: (tx: unknown) => unknown) => callback({ notification: mocks })),
}));
vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, res: any, next: () => void) => {
    const match = /^Bearer tenant-(.+)$/.exec(req.headers.authorization ?? '');
    if (!match) return res.status(401).json({ success: false, error: 'Authentication required' });
    req.user = { userId: match[1] };
    next();
  },
}));

import { notificationRoutes } from './notifications';

describe('notification privacy headers', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    const app = express();
    app.use('/api/notifications', notificationRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/notifications`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('sets no-store on authenticated notification responses', async () => {
    const response = await fetch(baseUrl, { headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not expose the route or privacy metadata before authentication', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('rejects malformed pagination cursors before querying tenant data', async () => {
    const response = await fetch(`${baseUrl}?before=not-a-cursor`, { headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('returns a bounded page and opaque cursor when older notifications exist', async () => {
    const notifications = Array.from({ length: 51 }, (_, index) => ({
      id: `notification-${index}`,
      createdAt: new Date(`2026-09-${String(17 - Math.floor(index / 3)).padStart(2, '0')}T00:00:00.000Z`),
    }));
    mocks.findMany.mockResolvedValueOnce(notifications);
    const response = await fetch(baseUrl, { headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-next-notification-cursor')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await response.json()).data).toHaveLength(50);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 51,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
  });
});
