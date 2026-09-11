import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverJobs, fetchDiscoveryRuns } from './api';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem('jobagent.accessToken', 'test-token');
  vi.stubGlobal('window', { sessionStorage, localStorage });
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'operation-1234') });
  vi.restoreAllMocks();
});

const durableRun = {
  id: 'run-1',
  automationJobId: 'automation-1',
  status: 'RUNNING',
  sources: [{ provider: 'ASHBY', account: 'fixture-invalid' }],
  query: 'engineer',
  location: 'Remote',
  discoveredCount: 4,
  normalizedCount: 3,
  duplicateCount: 1,
  savedCount: 2,
  failedCount: 0,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:01.000Z',
};

describe('discovery API contract', () => {
  it('starts a durable discovery run with all provider arrays', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { runs: [durableRun] } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      greenhouseBoards: ['greenhouse-invalid'],
      leverCompanies: ['lever-invalid'],
      ashbyBoards: ['ashby-invalid'],
      query: 'engineer',
      location: 'Remote',
    };

    await expect(discoverJobs(request)).resolves.toEqual({
      runs: [expect.objectContaining({ id: 'run-1', automationJobId: 'automation-1', status: 'RUNNING', savedCount: 2 })],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/jobs/discover');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(request) });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('operation-1234');
  });

  it('reuses one operation key when retrying a lost response', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { runs: [durableRun] } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverJobs({ greenhouseBoards: [], leverCompanies: [], ashbyBoards: ['ashby-invalid'] })).resolves.toEqual({
      runs: [expect.objectContaining({ id: 'run-1' })],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe('operation-1234');
    expect(new Headers(second.headers).get('Idempotency-Key')).toBe('operation-1234');
    expect(first.body).toBe(second.body);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('does not retry HTTP errors with an operation key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Conflict' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverJobs({ greenhouseBoards: [], leverCompanies: [], ashbyBoards: ['ashby-invalid'] })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads newest durable runs and tolerates persistence-shaped fields', async () => {
    const persistenceRun = {
      id: 'run-db',
      status: 'SUCCEEDED',
      source: 'greenhouse',
      sourceAccount: 'fixture-invalid',
      query: { query: 'typescript', location: 'Remote' },
      itemsFetched: 7,
      itemsNormalized: 6,
      itemsDuplicate: 2,
      jobsCreated: 3,
      jobsUpdated: 1,
      itemsRejected: 1,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:02.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [persistenceRun, durableRun] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDiscoveryRuns(500)).resolves.toEqual([
      expect.objectContaining({
        id: 'run-db', status: 'SUCCEEDED', sources: [{ provider: 'GREENHOUSE', account: 'fixture-invalid' }],
        query: 'typescript', location: 'Remote', discoveredCount: 7, normalizedCount: 6,
        duplicateCount: 2, savedCount: 4, failedCount: 1,
      }),
      expect.objectContaining({ id: 'run-1', status: 'RUNNING' }),
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/discovery-runs?limit=100');
  });

  it('maps cancellation and partial failure details without losing automation identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [
        { ...durableRun, status: 'CANCELLED', errorClass: 'CANCELLED', errorCode: 'ABORTED', errorMessage: 'Cancelled by operator', errorRetryable: false },
        { ...durableRun, id: 'run-partial', automationJobId: 'automation-2', status: 'PARTIAL', errorClass: 'PERSISTENCE', errorCode: 'ITEM_REJECTED', errorMessage: 'One item was rejected', errorRetryable: true },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchDiscoveryRuns();
    expect(runs).toEqual([
      expect.objectContaining({ status: 'CANCELLED', automationJobId: 'automation-1', errorCode: 'ABORTED', errorRetryable: false }),
      expect.objectContaining({ status: 'PARTIAL', automationJobId: 'automation-2', errorCode: 'ITEM_REJECTED', errorRetryable: true }),
    ]);
  });

  it('passes abort signals through discovery requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [durableRun] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await fetchDiscoveryRuns(20, controller.signal);

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('uses UNKNOWN rather than presenting an unsupported status as success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{ ...durableRun, status: 'UNEXPECTED_BACKEND_VALUE' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchDiscoveryRuns();
    expect(runs[0].status).toBe('UNKNOWN');
  });
});
