import { describe, expect, it, vi } from 'vitest';
import type { GreenhouseFormPort } from '@jobagent/job-engine';
import { GreenhouseApplicationService } from './greenhouse-application';

function formPort(snapshot: Awaited<ReturnType<GreenhouseFormPort['snapshot']>>) {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  } satisfies GreenhouseFormPort;
}

describe('GreenhouseApplicationService', () => {
  it('fills a safe validated form without exposing profile values in durable answers', async () => {
    const port = formPort({
      step: 1,
      hasNextStep: false,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });
    const browserSessions = {
      start: vi.fn(async () => ({ session: { externalRef: 'session' }, replayed: false })),
      withPage: vi.fn(async (_userId, _reference, operation) => operation({})),
      close: vi.fn(async () => undefined),
    };
    const service = new GreenhouseApplicationService(
      browserSessions as never,
      () => port as never,
    );

    await expect(service.execute({
      userId: 'user', applicationId: 'application', workerId: 'worker', correlationId: 'correlation', idempotencyKey: 'key',
    })).rejects.toThrow('Application or user profile not found');
    expect(browserSessions.start).not.toHaveBeenCalled();
  });
});
