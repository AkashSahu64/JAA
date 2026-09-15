import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withService: vi.fn(),
  tx: { outboxEvent: { updateMany: vi.fn() }, $queryRaw: vi.fn() },
}));
vi.mock('@jobagent/database', () => ({ withService: mocks.withService }));

import { publishOutboxBatch } from './outbox-publisher';

describe('service-scoped outbox publisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('rejects invalid maintenance time before claiming events', async () => {
    await expect(publishOutboxBatch(vi.fn(), { now: new Date(Number.POSITIVE_INFINITY) }))
      .rejects.toThrow('now must be a valid Date');
    expect(mocks.withService).not.toHaveBeenCalled();
  });
  it('claims worker-wide events through the service database boundary', async () => {
    mocks.withService.mockImplementation(async (operation: (tx: typeof mocks.tx) => Promise<unknown>) => operation(mocks.tx));
    mocks.tx.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.$queryRaw.mockResolvedValue([]);

    await expect(publishOutboxBatch(vi.fn(), { workerId: 'notification-worker', batchSize: 1 })).resolves.toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
    expect(mocks.withService).toHaveBeenCalledOnce();
    expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it('leases and completes a notification event without application-client access', async () => {
    mocks.tx.outboxEvent.updateMany.mockReset().mockResolvedValue({ count: 0 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mocks.tx.$queryRaw.mockResolvedValueOnce([{
      id: 'event-1', userId: 'user-1', aggregateType: 'Application', aggregateId: 'application-1',
      eventType: 'application.status.transitioned', payload: { fromStatus: 'FORM_FILLED', toStatus: 'READY_TO_SUBMIT', version: 2 },
      schemaVersion: 1, correlationId: 'correlation-1', idempotencyKey: 'event-key-1', occurredAt: new Date(), publishAttempts: 1,
    }]);
    const transport = vi.fn(async () => undefined);

    await expect(publishOutboxBatch(transport, { workerId: 'notification-worker', batchSize: 1 })).resolves.toMatchObject({ claimed: 1, published: 1 });
    expect(transport).toHaveBeenCalledOnce();
    expect(mocks.withService).toHaveBeenCalledTimes(2);
  });
});
