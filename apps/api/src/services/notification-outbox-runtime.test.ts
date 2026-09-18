import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ publish: vi.fn(), consume: vi.fn(), broadcast: vi.fn() }));
vi.mock('./outbox-publisher', () => ({ publishOutboxBatch: mocks.publish }));
vi.mock('./notification-outbox-consumer', async () => {
  const actual = await vi.importActual<typeof import('./notification-outbox-consumer')>('./notification-outbox-consumer');
  return { ...actual, consumeNotificationOutboxEvent: mocks.consume };
});
vi.mock('../routes/sse', () => ({ broadcastToUser: mocks.broadcast }));

import { startNotificationOutboxRuntime } from './notification-outbox-runtime';

describe('notification outbox runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.publish.mockReset().mockResolvedValue({ claimed: 0, published: 0, retried: 0, failed: 0 });
    mocks.consume.mockReset();
    mocks.broadcast.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers on startup, suppresses overlapping ticks, and closes cleanly', async () => {
    let release!: () => void;
    mocks.publish.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ claimed: 1, published: 1, retried: 0, failed: 0 }); }));
    const runtime = startNotificationOutboxRuntime({ intervalMs: 250, batchSize: 7, workerId: 'notifications-fixture' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish.mock.calls[0]![0]).toEqual(expect.any(Function));
    expect(mocks.publish.mock.calls[0]![1]).toMatchObject({ workerId: 'notifications-fixture', batchSize: 7 });
    release();
    await Promise.resolve();
    await runtime.close();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('reports publisher errors and validates runtime bounds', async () => {
    expect(() => startNotificationOutboxRuntime({ intervalMs: 249 })).toThrow('at least 250ms');
    expect(() => startNotificationOutboxRuntime({ batchSize: 501 })).toThrow('between 1 and 500');
    expect(() => startNotificationOutboxRuntime({ shutdownTimeoutMs: 999 })).toThrow('shutdown timeout');
    expect(() => startNotificationOutboxRuntime({ shutdownTimeoutMs: 120_001 })).toThrow('between one second and two minutes');
    const error = new Error('database unavailable');
    mocks.publish.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const runtime = startNotificationOutboxRuntime({ onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
    await runtime.close();
  });

  it('broadcasts a committed notification with a resumable event id', async () => {
    vi.useRealTimers();
    const event = {
      id: 'outbox-1', userId: 'user-1', aggregateType: 'HumanVerification', aggregateId: 'verification-1',
      eventType: 'human-verification.requested', payload: { applicationId: 'application-1', verificationId: 'verification-1', type: 'CAPTCHA' },
      schemaVersion: 1, correlationId: 'correlation-1', idempotencyKey: 'human-verification-requested:verification-1',
      occurredAt: new Date(), publishAttempts: 1,
    };
    mocks.consume.mockResolvedValueOnce({ responseCode: 201, responseBody: { consumed: true }, replayed: false });
    mocks.publish.mockImplementationOnce(async (transport: (value: typeof event) => Promise<void>) => { await transport(event); return { claimed: 1, published: 1, retried: 0, failed: 0 }; });
    const runtime = startNotificationOutboxRuntime({ intervalMs: 250 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.broadcast).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: expect.any(String), type: 'notification' }));
    await runtime.close();
  });

  it('does not rebroadcast an idempotent outbox replay', async () => {
    vi.useRealTimers();
    const event = {
      id: 'outbox-replay', userId: 'user-1', aggregateType: 'HumanVerification', aggregateId: 'verification-1',
      eventType: 'human-verification.requested', payload: { applicationId: 'application-1', verificationId: 'verification-1', type: 'CAPTCHA' },
      schemaVersion: 1, correlationId: 'correlation-1', idempotencyKey: 'human-verification-requested:verification-1',
      occurredAt: new Date(), publishAttempts: 1,
    };
    mocks.consume
      .mockResolvedValueOnce({ responseCode: 201, responseBody: { consumed: true }, replayed: false })
      .mockResolvedValueOnce({ responseCode: 201, responseBody: { consumed: true }, replayed: true });
    mocks.publish.mockImplementationOnce(async (transport: (value: typeof event) => Promise<void>) => {
      await transport(event);
      await transport(event);
      return { claimed: 2, published: 2, retried: 0, failed: 0 };
    });
    const runtime = startNotificationOutboxRuntime({ intervalMs: 250 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.broadcast).toHaveBeenCalledOnce();
    await runtime.close();
  });
});
