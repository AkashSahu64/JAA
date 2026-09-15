import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withService: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({
  prisma: { $transaction: mocks.transaction },
  withTenant: vi.fn(),
  withService: mocks.withService,
}));

import { reconcileExpiredAutomationJobLeases } from './automation-jobs';

describe('expired automation lease recovery', () => {
  it('uses the service maintenance boundary for worker-wide recovery', async () => {
    const tx = { $executeRaw: mocks.executeRaw };
    mocks.withService.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    mocks.executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(5);

    await expect(reconcileExpiredAutomationJobLeases(new Date('2026-01-01T00:00:00.000Z')))
      .resolves.toEqual({ available: 5, deadLetter: 2 });
    expect(mocks.withService).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid recovery time before opening the maintenance boundary', async () => {
    mocks.withService.mockClear();
    await expect(reconcileExpiredAutomationJobLeases(new Date(Number.NaN)))
      .rejects.toThrow('now must be a valid Date');
    expect(mocks.withService).not.toHaveBeenCalled();
  });
});
