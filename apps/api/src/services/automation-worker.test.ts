import { JobStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeAutomationJob: vi.fn(),
  failAutomationJob: vi.fn(),
  leaseAutomationJob: vi.fn(),
  renewAutomationJobLease: vi.fn(),
  validateAutomationJobRetry: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  withService: vi.fn(),
  workerOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@jobagent/database', () => ({
  withService: mocks.withService,
}));

vi.mock('@jobagent/queue', () => ({
  AutomationQueueWorker: class {
    constructor(_name: string, options: Record<string, unknown>) {
      mocks.workerOptions = options;
    }
  },
}));

vi.mock('./automation-jobs', () => ({
  completeAutomationJob: mocks.completeAutomationJob,
  failAutomationJob: mocks.failAutomationJob,
  leaseAutomationJob: mocks.leaseAutomationJob,
  renewAutomationJobLease: mocks.renewAutomationJobLease,
  validateAutomationJobRetry: mocks.validateAutomationJobRetry,
  AutomationJobError: class AutomationJobError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
  AutomationJobRetryError: class AutomationJobRetryError extends Error {
    constructor(message: string, public readonly retryAfterMs: number | null = null) { super(message); }
  },
}));

import { AutomationJobError, AutomationJobRetryError } from './automation-jobs';
import { startAutomationWorker } from './automation-worker';

type TestMessage = {
  automationJobId: string;
  type: string;
  correlationId: string;
  payloadVersion: number;
  deliveryGeneration: number;
  dispatchAttempt: number;
};

const message: TestMessage = {
  automationJobId: 'automation-job-1',
  type: 'APPLICATION_SUBMIT',
  correlationId: 'correlation-1',
  payloadVersion: 1,
  deliveryGeneration: 7,
  dispatchAttempt: 1,
};

function callback<T extends (...args: never[]) => unknown>(name: string): T {
  return mocks.workerOptions![name] as T;
}

describe('automation worker retry authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerOptions = undefined;
    mocks.validateAutomationJobRetry.mockResolvedValue(undefined);
    mocks.withService.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => operation({ automationJob: { findFirst: mocks.findFirst, findUnique: mocks.findUnique } }));
  });

  it('completes a BullMQ retry using its current lease rather than the original dispatch attempt', async () => {
    const firstLease = {
      id: message.automationJobId,
      userId: 'user-1',
      type: message.type,
      payload: { target: 'https://jobs.example.invalid/1' },
      payloadVersion: message.payloadVersion,
      correlationId: message.correlationId,
      deliveryGeneration: message.deliveryGeneration,
      attemptCount: 1,
    };
    const secondLease = { ...firstLease, attemptCount: 2 };
    mocks.leaseAutomationJob
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(secondLease);
    mocks.findFirst
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(secondLease);
    mocks.failAutomationJob.mockResolvedValue({ ...firstLease, status: JobStatus.AVAILABLE });
    mocks.completeAutomationJob.mockResolvedValue({ ...secondLease, status: JobStatus.SUCCEEDED });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce(undefined);

    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler });
    const processor = callback<(message: TestMessage, context: { workerId: string; signal: AbortSignal; heartbeat: () => Promise<void> }) => Promise<unknown>>('processor');
    const onFailure = callback<(message: TestMessage, error: Error, retryDelayMs: number) => Promise<string>>('onFailure');
    const onComplete = callback<(message: TestMessage, result: { outcome: 'EXECUTED' }) => Promise<void>>('onComplete');
    const context = {
      workerId: 'worker-1',
      signal: new AbortController().signal,
      heartbeat: vi.fn().mockResolvedValue(undefined),
    };

    await expect(processor(message, context)).rejects.toThrow('transient failure');
    await expect(onFailure(message, new Error('transient failure'), 1_000)).resolves.toBe('RETRY');
    const result = await processor(message, context);
    await onComplete(message, result as { outcome: 'EXECUTED' });

    expect(mocks.leaseAutomationJob).toHaveBeenCalledTimes(2);
    expect(mocks.leaseAutomationJob).toHaveBeenLastCalledWith(expect.objectContaining({
      jobId: message.automationJobId,
      deliveryGeneration: message.deliveryGeneration,
      expectedAttempt: message.dispatchAttempt,
    }));
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveryGeneration: firstLease.deliveryGeneration,
      attempt: firstLease.attemptCount,
    }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deliveryGeneration: secondLease.deliveryGeneration,
      attempt: secondLease.attemptCount,
    }));
    expect(mocks.failAutomationJob).toHaveBeenCalledOnce();
    expect(mocks.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: message.automationJobId,
        status: JobStatus.LEASED,
        deliveryGeneration: message.deliveryGeneration,
        leaseOwner: 'worker-1',
        leaseExpiresAt: { gt: expect.any(Date) },
      },
    });
    expect(mocks.completeAutomationJob).toHaveBeenCalledWith({
      jobId: message.automationJobId,
      workerId: 'worker-1',
    });
  });

  it('includes bounded application/provider trace context without logging job payloads', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const leased = {
      id: message.automationJobId,
      userId: 'user-1',
      type: message.type,
      payload: { applicationId: 'application-1', providerName: 'greenhouse', answer: 'secret' },
      payloadVersion: message.payloadVersion,
      correlationId: message.correlationId,
      deliveryGeneration: message.deliveryGeneration,
      attemptCount: 1,
    };
    mocks.leaseAutomationJob.mockResolvedValue(leased);
    const handler = vi.fn().mockResolvedValue(undefined);
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler });
    const processor = callback<(message: TestMessage, context: { workerId: string; signal: AbortSignal; heartbeat: () => Promise<void> }) => Promise<unknown>>('processor');

    await processor(message, { workerId: 'worker-1', signal: new AbortController().signal, heartbeat: vi.fn().mockResolvedValue(undefined) });

    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ applicationId: 'application-1', provider: 'greenhouse', automationJobId: message.automationJobId, queue: 'applications' });
    expect(JSON.stringify(record)).not.toContain('secret');
    output.mockRestore();
  });

  it('authorizes the exact retry transition before queue data is advanced', async () => {
    const events: string[] = [];
    mocks.validateAutomationJobRetry.mockImplementation(async () => { events.push('postgres'); });
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });

    const onRetry = callback<(message: TestMessage, context: { nextDispatchAttempt: number; deliveryGeneration: number }) => Promise<void>>('onRetry');
    await onRetry(message, { nextDispatchAttempt: 2, deliveryGeneration: message.deliveryGeneration });

    expect(mocks.validateAutomationJobRetry).toHaveBeenCalledWith({
      jobId: message.automationJobId,
      deliveryGeneration: message.deliveryGeneration,
      expectedAttempt: message.dispatchAttempt,
      nextDispatchAttempt: 2,
    });
    expect(events).toEqual(['postgres']);
  });

  it('denies a stale delivery generation retry transition', async () => {
    mocks.validateAutomationJobRetry.mockRejectedValue(new Error('stale generation'));
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });

    const onRetry = callback<(message: TestMessage, context: { nextDispatchAttempt: number; deliveryGeneration: number }) => Promise<void>>('onRetry');
    await expect(onRetry(message, { nextDispatchAttempt: 2, deliveryGeneration: 6 })).rejects.toThrow('stale generation');
  });

  it('passes retry hints only for AutomationJobRetryError', async () => {
    const leased = { ...message, id: message.automationJobId, userId: 'user-1', payload: {}, attemptCount: 1 };
    mocks.findFirst.mockResolvedValue(leased);
    mocks.failAutomationJob.mockResolvedValue({ ...leased, status: JobStatus.AVAILABLE });
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });
    const onFailure = callback<(message: TestMessage, error: Error, retryDelayMs: number) => Promise<string>>('onFailure');

    await onFailure(message, new AutomationJobRetryError('limited', 9_000), 1_000);
    expect(mocks.failAutomationJob).toHaveBeenLastCalledWith(expect.objectContaining({
      error: 'limited', providerRetryAfterMs: 9_000,
    }));

    await onFailure(message, new Error('ordinary'), 1_000);
    expect(mocks.failAutomationJob).toHaveBeenLastCalledWith(expect.objectContaining({
      error: 'ordinary', providerRetryAfterMs: undefined,
    }));
  });

  it('includes authoritative provider/application trace context on failure records', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const leased = {
      ...message,
      id: message.automationJobId,
      userId: 'user-1',
      payload: { applicationId: 'application-1', provider: 'lever', answer: 'must not log' },
      attemptCount: 1,
    };
    mocks.findFirst.mockResolvedValue(leased);
    mocks.failAutomationJob.mockResolvedValue({ ...leased, status: JobStatus.AVAILABLE });
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });
    const onFailure = callback<(message: TestMessage, error: Error, retryDelayMs: number) => Promise<string>>('onFailure');

    await expect(onFailure(message, new Error('provider failure'), 1_000)).resolves.toBe('RETRY');
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ applicationId: 'application-1', provider: 'lever', automationJobId: message.automationJobId, queue: 'applications' });
    expect(JSON.stringify(record)).not.toContain('must not log');
    output.mockRestore();
  });

  it('normalizes non-Error failures so retry/dead-letter handling is not masked', async () => {
    const leased = { ...message, id: message.automationJobId, userId: 'user-1', payload: {}, attemptCount: 1 };
    mocks.findFirst.mockResolvedValue(leased);
    mocks.failAutomationJob.mockResolvedValue({ ...leased, status: JobStatus.AVAILABLE });
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });
    const onFailure = callback<(message: TestMessage, error: Error, retryDelayMs: number) => Promise<string>>('onFailure');

    await expect(onFailure(message, 'provider rejected' as never, 1_000)).resolves.toBe('RETRY');
    expect(mocks.failAutomationJob).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'Unknown automation failure' }));
  });

  it('classifies only conclusive lease-lost errors', () => {
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });
    const isLeaseLost = callback<(error: unknown) => boolean>('isLeaseLost');

    expect(isLeaseLost(new AutomationJobError('LEASE_LOST', 'lost'))).toBe(true);
    expect(isLeaseLost(new AutomationJobError('NOT_FOUND', 'missing'))).toBe(false);
    expect(isLeaseLost(new Error('lease lost'))).toBe(false);
  });

  it('denies completion when the delivery generation is stale', async () => {
    mocks.findFirst.mockResolvedValue(null);
    startAutomationWorker({ name: 'applications', workerId: 'worker-1', handler: vi.fn() });

    const onComplete = callback<(message: TestMessage, result: { outcome: 'EXECUTED' }) => Promise<void>>('onComplete');
    await onComplete(message, { outcome: 'EXECUTED' });

    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deliveryGeneration: message.deliveryGeneration }),
    }));
    expect(mocks.completeAutomationJob).not.toHaveBeenCalled();
  });
});
