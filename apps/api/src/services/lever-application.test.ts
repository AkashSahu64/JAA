import { describe, expect, it, vi } from 'vitest';
import type { LeverFormPort } from '@jobagent/job-engine';
import { LeverApplicationService } from './lever-application';

const describeDatabase = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL) ? describe : describe.skip;

function formPort(snapshot: Awaited<ReturnType<LeverFormPort['snapshot']>>) {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  } satisfies LeverFormPort;
}

describeDatabase('LeverApplicationService', () => {
  it('checks durable tenant data before opening a browser session', async () => {
    const browserSessions = {
      start: vi.fn(async () => ({ session: { externalRef: 'session' }, replayed: false })),
      withPage: vi.fn(async (_userId, _reference, operation) => operation({})),
      close: vi.fn(async () => undefined),
    };
    const service = new LeverApplicationService(browserSessions as never, () => formPort({
      step: 1, hasNextStep: false,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    }));

    await expect(service.execute({
      userId: 'user', applicationId: 'application', workerId: 'worker', correlationId: 'correlation', idempotencyKey: 'key',
    })).rejects.toThrow('Application or user profile not found');
    expect(browserSessions.start).not.toHaveBeenCalled();
  });
});
