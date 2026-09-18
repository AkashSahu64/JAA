import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ purge: vi.fn() }));

vi.mock('./document-retention', () => ({ purgeExpiredDocuments: mocks.purge }));
vi.mock('./document-storage', () => ({ DocumentStorage: class {} }));

import { DocumentRetentionRuntime } from './document-retention-runtime';

describe('DocumentRetentionRuntime', () => {
  beforeEach(() => {
    mocks.purge.mockReset().mockResolvedValue({ deleted: 0, failedObjectIds: [] });
    vi.useRealTimers();
  });

  it('validates bounded interval and shutdown configuration', () => {
    expect(() => new DocumentRetentionRuntime({ intervalMs: 999 })).toThrow('Document retention interval must be at least one second');
    expect(() => new DocumentRetentionRuntime({ shutdownTimeoutMs: 999 })).toThrow('Document retention shutdown timeout must be between one second and two minutes');
    expect(() => new DocumentRetentionRuntime({ shutdownTimeoutMs: 120_001 })).toThrow('between one second and two minutes');
  });

  it('coalesces overlapping runs and schedules future retention work', async () => {
    vi.useFakeTimers();
    mocks.purge.mockResolvedValueOnce({ deleted: 2, failedObjectIds: [] }).mockResolvedValue({ deleted: 1, failedObjectIds: [] });
    const runtime = new DocumentRetentionRuntime({ intervalMs: 1_000, storage: { deleteAuthorized: vi.fn() } });
    await expect(runtime.start()).resolves.toEqual({ deleted: 2, failedObjectIds: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.purge).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it('reports purge failures and does not hide them from the caller', async () => {
    const onError = vi.fn();
    const failure = new Error('database unavailable');
    mocks.purge.mockRejectedValue(failure);
    const runtime = new DocumentRetentionRuntime({ storage: { deleteAuthorized: vi.fn() }, onError });
    await expect(runtime.runOnce()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('bounds shutdown when retention is stuck', async () => {
    vi.useFakeTimers();
    mocks.purge.mockImplementationOnce(() => new Promise(() => undefined));
    const runtime = new DocumentRetentionRuntime({ intervalMs: 1_000, shutdownTimeoutMs: 1_000, storage: { deleteAuthorized: vi.fn() } });
    void runtime.runOnce();
    await vi.waitFor(() => expect(mocks.purge).toHaveBeenCalledOnce());
    const closing = runtime.close();
    const assertion = expect(closing).rejects.toThrow('Document retention did not stop before the shutdown timeout');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
