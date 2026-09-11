import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, WorkerOptions } from 'bullmq';
import type { AutomationQueueMessage } from './registry';
import type { AutomationWorkerResult } from './worker';

const harness = vi.hoisted(() => ({
  processor: undefined as unknown,
  options: undefined as unknown,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    pause = vi.fn();
    resume = vi.fn();
    close = vi.fn();

    constructor(_name: string, processor: unknown, options: unknown) {
      harness.processor = processor;
      harness.options = options;
    }
  },
}));

import { AutomationQueueWorker } from './worker';

type Processor = (job: Job<AutomationQueueMessage>) => Promise<AutomationWorkerResult | void>;
type BackoffStrategy = NonNullable<NonNullable<WorkerOptions['settings']>['backoffStrategy']>;

const initialMessage: AutomationQueueMessage = {
  automationJobId: 'automation-job',
  type: 'APPLICATION_FIXTURE',
  correlationId: 'correlation',
  payloadVersion: 1,
  deliveryGeneration: 7,
  dispatchAttempt: 3,
};

function queueJob(message: AutomationQueueMessage): Job<AutomationQueueMessage> {
  const job = {
    attemptsMade: 0,
    data: message,
    updateData: vi.fn(async (data: AutomationQueueMessage) => {
      job.data = data;
    }),
  };
  return job as unknown as Job<AutomationQueueMessage>;
}

describe('AutomationQueueWorker retries', () => {
  beforeEach(() => {
    vi.useRealTimers();
    harness.processor = undefined;
    harness.options = undefined;
  });

  it('serializes automatic renewals and does not abort on a transient renewal failure', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstRenewal = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let renewalCalls = 0;
    let releaseProcessor!: () => void;
    const processorReleased = new Promise<void>((resolve) => { releaseProcessor = resolve; });
    let observedSignal: AbortSignal | undefined;
    const worker = new AutomationQueueWorker('applications', {
      workerId: 'worker',
      leaseMs: 3_000,
      processor: async (_message, context) => {
        observedSignal = context.signal;
        await processorReleased;
      },
      onFailure: async () => 'IGNORED',
      shouldRetry: async () => false,
      onComplete: async () => undefined,
      onRenew: async () => {
        renewalCalls += 1;
        if (renewalCalls === 1) await firstRenewal;
        else if (renewalCalls === 2) throw new Error('transient database outage');
      },
      isLeaseLost: (error) => error instanceof Error && error.message === 'lease lost',
    });
    const processing = (harness.processor as Processor)(queueJob(initialMessage));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewalCalls).toBe(1);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(renewalCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewalCalls).toBe(2);
    expect(observedSignal?.aborted).toBe(false);

    releaseProcessor();
    await processing;
    await worker.close();
  });

  it('aborts processing when renewal proves the lease was lost', async () => {
    vi.useFakeTimers();
    let releaseProcessor!: () => void;
    const processorReleased = new Promise<void>((resolve) => { releaseProcessor = resolve; });
    let observedSignal: AbortSignal | undefined;
    const worker = new AutomationQueueWorker('applications', {
      workerId: 'worker',
      leaseMs: 3_000,
      processor: async (_message, context) => {
        observedSignal = context.signal;
        await processorReleased;
      },
      onFailure: async () => 'IGNORED',
      shouldRetry: async () => false,
      onComplete: async () => undefined,
      onRenew: async () => { throw new Error('lease lost'); },
      isLeaseLost: (error) => error instanceof Error && error.message === 'lease lost',
    });
    const processing = (harness.processor as Processor)(queueJob(initialMessage));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(observedSignal?.aborted).toBe(true);

    releaseProcessor();
    await processing;
    await worker.close();
  });

  it('persists the next attempt before a delayed retry processes and never completes the stale attempt', async () => {
    const events: string[] = [];
    const processedAttempts: number[] = [];
    const completedAttempts: number[] = [];
    const worker = new AutomationQueueWorker('applications', {
      workerId: 'worker',
      processor: async (message) => {
        processedAttempts.push(message.dispatchAttempt);
        events.push(`processor:${message.dispatchAttempt}`);
        if (message.dispatchAttempt === 3) throw new Error('retry');
        return { outcome: 'EXECUTED' };
      },
      onFailure: async (message) => {
        events.push(`failure:${message.dispatchAttempt}`);
        return 'RETRY';
      },
      shouldRetry: async (message) => {
        events.push(`shouldRetry:${message.dispatchAttempt}`);
        return true;
      },
      onRetry: async (_message, context) => {
        events.push(`onRetry:${context.nextDispatchAttempt}`);
        expect(context).toEqual({
          failedAttempts: 1,
          nextDispatchAttempt: 4,
          deliveryGeneration: 7,
        });
      },
      onComplete: async (message) => {
        completedAttempts.push(message.dispatchAttempt);
        events.push(`complete:${message.dispatchAttempt}`);
      },
      onRenew: async () => undefined,
    });
    const job = queueJob(initialMessage);
    const processor = harness.processor as Processor;
    const backoff = (harness.options as WorkerOptions).settings!.backoffStrategy as BackoffStrategy;

    await expect(processor(job)).rejects.toThrow('retry');
    expect(completedAttempts).toEqual([]);

    await expect(backoff(1, 'jobagent-retry', new Error('retry'), job)).resolves.toBeGreaterThan(0);
    expect(job.updateData).toHaveBeenCalledWith({ ...initialMessage, dispatchAttempt: 4 });
    expect(job.data).toEqual({ ...initialMessage, dispatchAttempt: 4 });
    expect(job.data.deliveryGeneration).toBe(7);

    job.attemptsMade = 1;
    await expect(processor(job)).resolves.toEqual({ outcome: 'EXECUTED' });
    expect(processedAttempts).toEqual([3, 4]);
    expect(completedAttempts).toEqual([4]);
    expect(events).toEqual([
      'processor:3',
      'failure:3',
      'shouldRetry:3',
      'onRetry:4',
      'processor:4',
      'complete:4',
    ]);
    await worker.close();
  });

  it('does not mutate the envelope when authoritative retry preparation fails', async () => {
    const worker = new AutomationQueueWorker('applications', {
      workerId: 'worker',
      processor: async () => undefined,
      onFailure: async () => 'RETRY',
      shouldRetry: async () => true,
      onRetry: async () => { throw new Error('authoritative attempt conflict'); },
      onComplete: async () => undefined,
      onRenew: async () => undefined,
    });
    const job = queueJob(initialMessage);
    const backoff = (harness.options as WorkerOptions).settings!.backoffStrategy as BackoffStrategy;

    await expect(backoff(1, 'jobagent-retry', new Error('retry'), job))
      .rejects.toThrow('authoritative attempt conflict');
    expect(job.updateData).not.toHaveBeenCalled();
    await worker.close();
  });
});
