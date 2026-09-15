import { describe, expect, it, vi } from 'vitest';
import { collectQueueMetrics } from './metrics';

describe('queue metrics', () => {
  it('reports bounded age for the oldest waiting job', async () => {
    const now = Date.now();
    const queue = {
      getJobCounts: vi.fn(async () => ({ wait: 2, active: 1, delayed: 0, prioritized: 0, completed: 4, failed: 1 })),
      isPaused: vi.fn(async () => false),
      getJobs: vi.fn(async () => [{ timestamp: now - 2_000 }, { timestamp: now - 5_000 }]),
    };
    const metrics = await collectQueueMetrics({ queue: () => queue } as never, ['applications']);
    expect(metrics).toEqual([{ queue: 'applications', waiting: 2, oldestWaitingMs: expect.any(Number), active: 1, delayed: 0, prioritized: 0, completed: 4, failed: 1, paused: 0 }]);
    expect(metrics[0]!.oldestWaitingMs).toBeGreaterThanOrEqual(4_000);
    expect(metrics[0]!.oldestWaitingMs).toBeLessThan(7 * 24 * 60 * 60 * 1_000);
  });

  it('returns null age for empty or malformed waiting jobs', async () => {
    const queue = {
      getJobCounts: vi.fn(async () => ({})),
      isPaused: vi.fn(async () => true),
      getJobs: vi.fn(async () => [{ timestamp: 'invalid' }, { timestamp: -1 }]),
    };
    await expect(collectQueueMetrics({ queue: () => queue } as never, ['applications'])).resolves.toMatchObject([{ oldestWaitingMs: null, paused: 1 }]);
  });

  it('normalizes corrupt queue counts before they reach operational alerts', async () => {
    const queue = {
      getJobCounts: vi.fn(async () => ({
        wait: -1,
        active: Number.NaN,
        delayed: Number.POSITIVE_INFINITY,
        prioritized: 1.5,
        completed: Number.MAX_SAFE_INTEGER + 1,
        failed: 2,
      })),
      isPaused: vi.fn(async () => false),
      getJobs: vi.fn(async () => []),
    };

    await expect(collectQueueMetrics({ queue: () => queue } as never, ['applications'])).resolves.toEqual([{
      queue: 'applications', waiting: 0, oldestWaitingMs: null, active: 0, delayed: 0,
      prioritized: 0, completed: 1_000_000_000, failed: 2, paused: 0,
    }]);
  });
});
