import { beforeEach, describe, expect, it, vi } from 'vitest';

const withTenant = vi.hoisted(() => vi.fn());
vi.mock('@jobagent/database', () => ({ withTenant }));

import { persistAutomationAlerts } from './automation-alert-outbox';

describe('automation alert outbox persistence', () => {
  const upsert = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    withTenant.mockImplementation(async (_userId: string, operation: (tx: unknown) => Promise<unknown>) => operation({ outboxEvent: { upsert } }));
  });

  it('writes bounded idempotent tenant-owned alert events', async () => {
    const now = new Date('2026-09-16T00:00:00.000Z');
    await persistAutomationAlerts('user-1', [{ code: 'QUEUE_FAILURES', severity: 'CRITICAL', message: 'Queue failure', value: 2, threshold: 1 }], 'corr-1', now);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: 'automation-alert:user-1:QUEUE_FAILURES:5965056' },
      create: expect.objectContaining({ userId: 'user-1', aggregateType: 'AutomationOperations', eventType: 'automation.alert', correlationId: 'corr-1', payload: expect.objectContaining({ code: 'QUEUE_FAILURES' }) }),
      update: {},
    }));
  });

  it('does not open a tenant transaction for a healthy alert set', async () => {
    await persistAutomationAlerts('user-1', [], 'corr-1');
    expect(withTenant).not.toHaveBeenCalled();
  });
});
