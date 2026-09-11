import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  dispatch: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@jobagent/queue', () => ({
  AutomationQueueRegistry: class {
    close = mocks.close;
  },
}));

vi.mock('./automation-job-dispatcher', () => ({
  dispatchAutomationJobs: mocks.dispatch,
}));

vi.mock('./automation-jobs', () => ({
  reconcileExpiredAutomationJobLeases: mocks.reconcile,
}));

import { AutomationDispatcherRuntime } from './automation-dispatcher-runtime';

const emptyResult = { selected: 0, dispatched: 0, failed: 0 };

describe('AutomationDispatcherRuntime', () => {
  beforeEach(() => {
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.dispatch.mockReset().mockResolvedValue(emptyResult);
    mocks.reconcile.mockReset().mockResolvedValue({ available: 0, deadLetter: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates interval and batch configuration', () => {
    expect(() => new AutomationDispatcherRuntime({ intervalMs: 0 })).toThrow('intervalMs must be a positive integer');
    expect(() => new AutomationDispatcherRuntime({ batchSize: 1.5 })).toThrow('batchSize must be a positive integer');
  });

  it('reconciles before dispatch and shares an overlapping pass', async () => {
    let release!: () => void;
    mocks.dispatch.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ selected: 1, dispatched: 1, failed: 0 });
    }));
    const runtime = new AutomationDispatcherRuntime({ batchSize: 7 });
    const first = runtime.dispatchOnce();
    const second = runtime.dispatchOnce();

    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { selected: 1, dispatched: 1, failed: 0 },
      { selected: 1, dispatched: 1, failed: 0 },
    ]);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.dispatch.mock.calls[0]![1]).toEqual({ batchSize: 7 });
    await runtime.close();
  });

  it('starts immediately, rejects duplicate starts, and reports interval errors', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    mocks.dispatch
      .mockResolvedValueOnce({ selected: 1, dispatched: 1, failed: 0 })
      .mockRejectedValueOnce(new Error('redis unavailable'));
    const runtime = new AutomationDispatcherRuntime({ intervalMs: 50, onError });

    await expect(runtime.start()).resolves.toEqual({ selected: 1, dispatched: 1, failed: 0 });
    await expect(runtime.start()).rejects.toThrow('Automation dispatcher is already running');
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis unavailable' })));
    await runtime.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('waits for an active dispatch before closing its registry', async () => {
    let release!: () => void;
    mocks.dispatch.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(emptyResult);
    }));
    const runtime = new AutomationDispatcherRuntime();
    const dispatch = runtime.dispatchOnce();
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    const closing = runtime.close();
    expect(mocks.close).not.toHaveBeenCalled();
    release();
    await Promise.all([dispatch, closing]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
