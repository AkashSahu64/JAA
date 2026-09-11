import { describe, expect, it, vi } from 'vitest';
import {
  DiscoveryExecutionAbortedError,
  DiscoveryTask,
  executeDiscovery,
  retryAfterFromError,
} from './discovery-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('executeDiscovery', () => {
  it('bounds concurrency, isolates failures, and returns input order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    let active = 0;
    let peak = 0;
    const tasks: Array<DiscoveryTask<string>> = gates.map((gate, index) => ({
      source: `source-${index}`,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        try { return await gate.promise; } finally { active -= 1; }
      },
    }));

    const execution = executeDiscovery(tasks, { concurrency: 2 });
    await flush();
    expect(active).toBe(2);
    gates[1].resolve('one');
    await flush();
    expect(active).toBe(2);
    gates[0].resolve('zero');
    await flush();
    gates[2].reject(new Error('fixture failure'));
    gates[3].resolve('three');

    const results = await execution;
    expect(peak).toBe(2);
    expect(results.map(result => result.index)).toEqual([0, 1, 2, 3]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'zero', attempts: 1 });
    expect(results[2]).toMatchObject({ status: 'rejected', attempts: 1 });
  });

  it('enforces source intervals with an injected clock', async () => {
    let now = 0;
    const starts: number[] = [];
    const sleep = vi.fn(async (delayMs: number) => { now += delayMs; });
    const tasks = [0, 1, 2].map(value => ({
      source: 'greenhouse',
      run: () => { starts.push(now); return value; },
    }));

    const results = await executeDiscovery(tasks, {
      concurrency: 3,
      sourceRateLimits: { greenhouse: { concurrency: 1, minIntervalMs: 25 } },
      now: () => now,
      sleep,
    });

    expect(starts).toEqual([0, 25, 50]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.every(([delay]) => delay === 25)).toBe(true);
    expect(results.map(result => result.status === 'fulfilled' ? result.value : undefined)).toEqual([0, 1, 2]);
  });

  it('honors retry-after for the whole source and uses bounded attempts', async () => {
    let now = 0;
    const starts: string[] = [];
    let firstAttempts = 0;
    const tasks: Array<DiscoveryTask<string>> = [
      {
        source: 'lever',
        run: () => {
          starts.push(`first:${now}`);
          firstAttempts += 1;
          if (firstAttempts === 1) throw Object.assign(new Error('rate limited'), { retryAfterMs: 100 });
          return 'first';
        },
      },
      { source: 'lever', run: () => { starts.push(`second:${now}`); return 'second'; } },
    ];

    const results = await executeDiscovery(tasks, {
      concurrency: 2,
      sourceRateLimits: { lever: { concurrency: 1 } },
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 500 },
      now: () => now,
      sleep: async delayMs => { now += delayMs; },
    });

    expect(starts).toEqual(['first:0', 'second:100', 'first:100']);
    expect(results).toMatchObject([
      { status: 'fulfilled', value: 'first', attempts: 2 },
      { status: 'fulfilled', value: 'second', attempts: 1 },
    ]);
  });

  it('stops scheduling and rejects promptly on cancellation', async () => {
    const controller = new AbortController();
    const gate = deferred<string>();
    const starts: number[] = [];
    const execution = executeDiscovery([
      { source: 'ashby', run: async () => { starts.push(0); return gate.promise; } },
      { source: 'ashby', run: () => { starts.push(1); return 'unexpected'; } },
    ], { concurrency: 1, signal: controller.signal });

    await flush();
    controller.abort('fixture cancellation');
    await expect(execution).rejects.toEqual(expect.objectContaining<Partial<DiscoveryExecutionAbortedError>>({
      name: 'DiscoveryExecutionAbortedError',
      reason: 'fixture cancellation',
    }));
    expect(starts).toEqual([0]);
    gate.resolve('ignored');
  });

  it('caps materialization before running tasks', async () => {
    let started = 0;
    const tasks = Array.from({ length: 3 }, (_, index) => ({
      source: 'greenhouse',
      run: () => { started += 1; return index; },
    }));
    await expect(executeDiscovery(tasks, { maxTasks: 2 })).rejects.toThrow('exceeds maxTasks');
    expect(started).toBe(0);
  });

  it('parses retry-after seconds and HTTP dates', () => {
    expect(retryAfterFromError({ response: { headers: new Headers({ 'retry-after': '2.5' }) } }, 0)).toBe(2_500);
    expect(retryAfterFromError({ headers: new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' }) }, 1_000)).toBe(2_000);
    expect(retryAfterFromError({ retryAfterMs: -1 }, 0)).toBe(0);
  });
});
