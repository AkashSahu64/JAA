import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withTenant: vi.fn(), ingest: vi.fn() }));
vi.mock('@jobagent/database', () => ({ withTenant: mocks.withTenant }));
vi.mock('./email-outcomes', () => ({ ingestEmailOutcome: mocks.ingest }));

import { syncEmailConnection } from './email-sync';

describe('mailbox sync cursor concurrency', () => {
  beforeEach(() => {
    mocks.withTenant.mockReset();
    mocks.ingest.mockReset().mockResolvedValue({ id: 'outcome-1' });
  });

  it('rejects a stale page when another sync already advanced the cursor', async () => {
    mocks.withTenant
      .mockResolvedValueOnce({ id: 'connection-1', provider: 'GMAIL', syncCursor: 'cursor-1' })
      .mockImplementationOnce(async (_userId: string, callback: (tx: unknown) => Promise<unknown>) => callback({
        emailConnection: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { create: vi.fn() },
      }));
    const connector = { provider: 'GMAIL', listMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: 'cursor-2' }) };
    await expect(syncEmailConnection({ userId: 'user-1', connectionId: 'connection-1', connector })).rejects.toThrow('cursor changed');
  });

  it('audits only after winning the durable cursor update', async () => {
    const audit = vi.fn();
    const update = vi.fn().mockResolvedValue({ count: 1 });
    mocks.withTenant
      .mockResolvedValueOnce({ id: 'connection-1', provider: 'GMAIL', syncCursor: null })
      .mockImplementationOnce(async (_userId: string, callback: (tx: unknown) => Promise<unknown>) => callback({
        emailConnection: { updateMany: update }, auditLog: { create: audit },
      }));
    const connector = { provider: 'GMAIL', listMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: 'cursor-2' }) };
    await expect(syncEmailConnection({ userId: 'user-1', connectionId: 'connection-1', correlationId: 'sync-correlation-1', connector })).resolves.toMatchObject({ nextCursor: 'cursor-2' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ syncCursor: null }) }));
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ details: expect.objectContaining({ correlationId: 'sync-correlation-1' }) }) }));
  });
});
