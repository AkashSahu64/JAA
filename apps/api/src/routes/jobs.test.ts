import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDiscoveryRuns: vi.fn(),
  listDiscoveryRuns: vi.fn(),
  getDiscoveryRun: vi.fn(),
  cancelDiscoveryRun: vi.fn(),
  createAutomationJob: vi.fn(),
  findJob: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({ prisma: { job: { findUnique: mocks.findJob } } }));
vi.mock('../services/automation-jobs', () => ({ createAutomationJob: mocks.createAutomationJob }));
vi.mock('../services/job-discovery', () => ({
  createDiscoveryRuns: mocks.createDiscoveryRuns,
  listDiscoveryRuns: mocks.listDiscoveryRuns,
  getDiscoveryRun: mocks.getDiscoveryRun,
  cancelDiscoveryRun: mocks.cancelDiscoveryRun,
}));
vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, res: any, next: () => void) => {
    const match = /^Bearer tenant-(.+)$/.exec(req.headers.authorization ?? '');
    if (!match) return res.status(401).json({ success: false, error: 'Authentication required' });
    req.user = { userId: match[1] };
    next();
  },
}));

import { jobRoutes } from './jobs';

describe('discovery routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/jobs`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function request(path: string, init: RequestInit = {}, tenant = 'user-1') {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer tenant-${tenant}`,
        'content-type': 'application/json',
        ...(init.method === 'POST' && path === '/discover' ? { 'idempotency-key': 'discovery-operation-1' } : {}),
        ...init.headers,
      },
    });
  }

  it('requires authentication before discovery services run', async () => {
    const response = await fetch(`${baseUrl}/discovery-runs`);
    expect(response.status).toBe(401);
    expect(mocks.listDiscoveryRuns).not.toHaveBeenCalled();
  });

  it('creates durable runs with normalized bounded input and exposes automationJobId', async () => {
    mocks.createDiscoveryRuns.mockResolvedValue([{
      id: 'run-1', automationJobId: 'automation-1', status: 'PENDING', errorRetryAfterMs: null,
    }]);

    const response = await request('/discover', {
      method: 'POST',
      body: JSON.stringify({ greenhouseBoards: [' Acme ', 'acme'], query: 'platform' }),
    });

    expect(response.status).toBe(202);
    expect(mocks.createDiscoveryRuns).toHaveBeenCalledWith('user-1', {
      greenhouseBoards: ['acme'], leverCompanies: [], ashbyBoards: [], query: 'platform', location: undefined,
    }, 'discovery-operation-1');
    expect(await response.json()).toMatchObject({
      success: true,
      data: { runs: [{ id: 'run-1', automationJobId: 'automation-1', status: 'PENDING' }] },
    });
  });

  it('rejects missing or malformed operation keys before creating work', async () => {
    const missing = await request('/discover', {
      method: 'POST', body: JSON.stringify({ greenhouseBoards: ['acme'] }), headers: { 'idempotency-key': '' },
    });
    expect(missing.status).toBe(400);

    const malformed = await request('/discover', {
      method: 'POST', body: JSON.stringify({ greenhouseBoards: ['acme'] }), headers: { 'idempotency-key': 'contains spaces here' },
    });
    expect(malformed.status).toBe(400);

    const oversized = await request('/discover', {
      method: 'POST', body: JSON.stringify({ greenhouseBoards: ['acme'] }), headers: { 'idempotency-key': 'x'.repeat(129) },
    });
    expect(oversized.status).toBe(400);
    expect(mocks.createDiscoveryRuns).not.toHaveBeenCalled();
  });

  it('passes a repeated key through so the service can return the same durable runs', async () => {
    const runs = [{ id: 'run-1', automationJobId: 'automation-1', status: 'PENDING' }];
    mocks.createDiscoveryRuns.mockResolvedValue(runs);
    const init = {
      method: 'POST',
      body: JSON.stringify({ greenhouseBoards: ['acme'] }),
      headers: { 'idempotency-key': 'stable-operation-1234' },
    };

    const first = await request('/discover', init);
    const retry = await request('/discover', init);

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(mocks.createDiscoveryRuns).toHaveBeenNthCalledWith(1, 'user-1', {
      greenhouseBoards: ['acme'], leverCompanies: [], ashbyBoards: [], query: undefined, location: undefined,
    }, 'stable-operation-1234');
    expect(mocks.createDiscoveryRuns).toHaveBeenNthCalledWith(2, 'user-1', {
      greenhouseBoards: ['acme'], leverCompanies: [], ashbyBoards: [], query: undefined, location: undefined,
    }, 'stable-operation-1234');
    expect(await retry.json()).toEqual(await first.json());
  });

  it('scopes identical operation keys to the authenticated tenant', async () => {
    mocks.createDiscoveryRuns.mockResolvedValue([{ id: 'run-tenant', automationJobId: 'automation-tenant', status: 'PENDING' }]);
    const init = {
      method: 'POST',
      body: JSON.stringify({ greenhouseBoards: ['acme'] }),
      headers: { 'idempotency-key': 'shared-operation-1234' },
    };

    await request('/discover', init, 'tenant-a');
    await request('/discover', init, 'tenant-b');

    expect(mocks.createDiscoveryRuns).toHaveBeenNthCalledWith(1, 'tenant-a', expect.any(Object), 'shared-operation-1234');
    expect(mocks.createDiscoveryRuns).toHaveBeenNthCalledWith(2, 'tenant-b', expect.any(Object), 'shared-operation-1234');
  });

  it('maps a reused-key payload conflict to the standard 409 envelope', async () => {
    mocks.createDiscoveryRuns.mockRejectedValue(Object.assign(new Error('Key is already used for different input'), { code: 'REQUEST_CONFLICT' }));
    const response = await request('/discover', {
      method: 'POST',
      body: JSON.stringify({ greenhouseBoards: ['different'] }),
      headers: { 'idempotency-key': 'stable-operation-1234' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'Key is already used for different input' });
  });

  it('rejects oversized account lists before creating work', async () => {
    const response = await request('/discover', {
      method: 'POST', body: JSON.stringify({ greenhouseBoards: Array.from({ length: 21 }, (_, index) => `board-${index}`) }),
    });
    expect(response.status).toBe(400);
    expect(mocks.createDiscoveryRuns).not.toHaveBeenCalled();
  });

  it('lists only through the authenticated tenant scope with a bounded limit', async () => {
    mocks.listDiscoveryRuns.mockResolvedValue([{ id: 'run-1', automationJobId: 'automation-1' }]);
    const response = await request('/discovery-runs?limit=100', {}, 'tenant-a');
    expect(response.status).toBe(200);
    expect(mocks.listDiscoveryRuns).toHaveBeenCalledWith('tenant-a', 100);
    expect(await response.json()).toMatchObject({ success: true, data: [{ automationJobId: 'automation-1' }] });

    const invalid = await request('/discovery-runs?limit=101');
    expect(invalid.status).toBe(400);
  });

  it('returns tenant-scoped run status with its durable automation job id', async () => {
    mocks.getDiscoveryRun.mockResolvedValue(
      { id: 'run-owned', automationJobId: 'automation-owned', status: 'RUNNING', errorRetryAfterMs: null },
    );
    const response = await request('/discovery-runs/run-owned', {}, 'tenant-a');
    expect(response.status).toBe(200);
    expect(mocks.getDiscoveryRun).toHaveBeenCalledWith('tenant-a', 'run-owned');
    expect(await response.json()).toMatchObject({
      success: true, data: { id: 'run-owned', automationJobId: 'automation-owned', status: 'RUNNING' },
    });
  });

  it('uses direct lookup for runs older than the list window', async () => {
    mocks.getDiscoveryRun.mockResolvedValue({
      id: 'run-old', automationJobId: 'automation-old', status: 'SUCCEEDED', errorRetryAfterMs: null,
    });

    const response = await request('/discovery-runs/run-old', {}, 'tenant-a');

    expect(response.status).toBe(200);
    expect(mocks.getDiscoveryRun).toHaveBeenCalledWith('tenant-a', 'run-old');
    expect(mocks.listDiscoveryRuns).not.toHaveBeenCalled();
  });

  it('does not reveal runs absent from the authenticated tenant scope', async () => {
    mocks.getDiscoveryRun.mockResolvedValue(null);
    const response = await request('/discovery-runs/run-other', {}, 'tenant-a');
    expect(response.status).toBe(404);
    expect(mocks.getDiscoveryRun).toHaveBeenCalledWith('tenant-a', 'run-other');
    expect(mocks.cancelDiscoveryRun).not.toHaveBeenCalled();
  });

  it('cancels the durable automation job in tenant scope and returns refreshed status', async () => {
    mocks.cancelDiscoveryRun.mockResolvedValue({
      id: 'run-1', automationJobId: 'automation-1', status: 'CANCELLED', errorRetryAfterMs: null,
    });

    const response = await request('/discovery-runs/run-1/cancel', { method: 'POST', body: '{}' }, 'tenant-a');
    expect(response.status).toBe(200);
    expect(mocks.cancelDiscoveryRun).toHaveBeenCalledWith('tenant-a', 'run-1');
    expect(await response.json()).toMatchObject({
      success: true, data: { id: 'run-1', automationJobId: 'automation-1', status: 'CANCELLED' },
    });
  });

  it('queues an idempotent tenant-scoped deterministic match job', async () => {
    mocks.findJob.mockResolvedValue({ id: 'job-1' });
    mocks.createAutomationJob.mockResolvedValue({ id: 'match-1', status: 'AVAILABLE', replayed: false });

    const response = await request('/job-1/match', { method: 'POST', body: '{}' }, 'tenant-a');

    expect(response.status).toBe(202);
    expect(mocks.createAutomationJob).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'tenant-a', type: 'MATCH_JOB', payload: { jobId: 'job-1' }, payloadVersion: 1,
      correlationId: 'job-1', idempotencyKey: 'match-job:tenant-a:job-1',
    }));
    expect(await response.json()).toEqual({ success: true, data: { id: 'match-1', status: 'AVAILABLE', replayed: false } });
  });

  it('does not queue a match for an absent job', async () => {
    mocks.findJob.mockResolvedValue(null);
    const response = await request('/job-1/match', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    expect(mocks.createAutomationJob).not.toHaveBeenCalled();
  });

  it('rejects malformed run identifiers before tenant lookup', async () => {
    const response = await request('/discovery-runs/not%20safe');
    expect(response.status).toBe(400);
    expect(mocks.getDiscoveryRun).not.toHaveBeenCalled();
  });
});
