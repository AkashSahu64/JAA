import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withService: vi.fn(),
  withTenant: vi.fn(),
  queryRaw: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({
  withService: mocks.withService,
  withTenant: mocks.withTenant,
}));

import { dispatchAutomationJobs } from './automation-job-dispatcher';

describe('automation job dispatch boundaries', () => {
  it('selects through maintenance and audits dispatch failure through the tenant boundary', async () => {
    const job = {
      id: 'job-1', userId: 'tenant-a', type: 'DISCOVER_JOBS', correlationId: 'run-1',
      payloadVersion: 1, deliveryGeneration: 2, priority: 0,
      availableAt: new Date('2026-01-01T00:00:00.000Z'), requestedAvailableAt: null,
      attemptCount: 0, maxAttempts: 3,
    } as any;
    mocks.withService.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => operation({ $queryRaw: mocks.queryRaw }));
    mocks.withTenant.mockImplementation(async (_userId: string, operation: (tx: unknown) => Promise<unknown>) => operation({ auditLog: { create: mocks.auditCreate } }));
    mocks.queryRaw.mockResolvedValue([job]);
    const registry = { enqueue: vi.fn().mockRejectedValue(new Error('queue unavailable')) } as any;

    await expect(dispatchAutomationJobs(registry, { now: job.availableAt })).resolves.toEqual({ selected: 1, dispatched: 0, failed: 1 });
    expect(mocks.withService).toHaveBeenCalledTimes(1);
    expect(mocks.withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'tenant-a', resourceId: 'job-1' }) }));
  });
});
