import { describe, expect, it, vi } from 'vitest';
import type { AutomationJobHandlerContext } from './automation-worker';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import { AutomationJobRetryError } from './automation-jobs';

function context(): AutomationJobHandlerContext {
  return {
    automationJobId: 'automation-job',
    userId: 'user',
    type: 'DISCOVER_JOBS',
    payload: { runId: 'run' },
    payloadVersion: 1,
    correlationId: 'run',
    deliveryGeneration: 2,
    attempt: 1,
    workerId: 'worker',
    signal: new AbortController().signal,
    heartbeat: vi.fn(async () => undefined),
  };
}

describe('human-verification resume automation job handler', () => {
  it('registers the resume command and validates the payload version before execution', async () => {
    const handler = createProductionAutomationJobHandlers()
      .get('RESUME_APPLICATION_AFTER_VERIFICATION');
    expect(handler).toBeDefined();

    await expect(handler!({
      ...context(),
      type: 'RESUME_APPLICATION_AFTER_VERIFICATION',
      payload: { verificationId: 'verification-id' },
      payloadVersion: 2,
    })).rejects.toThrow('RESUME_APPLICATION_AFTER_VERIFICATION payloadVersion must be 1');
  });

  it('rejects a resume command without a verification identifier', async () => {
    const handler = createProductionAutomationJobHandlers()
      .get('RESUME_APPLICATION_AFTER_VERIFICATION')!;

    await expect(handler({
      ...context(),
      type: 'RESUME_APPLICATION_AFTER_VERIFICATION',
      payload: {},
    })).rejects.toThrow('verificationId is required');
  });
});
describe('discovery automation job handler', () => {
  it('throws a structured retry error with the discovery retry hint', async () => {
    const executeDiscoveryRun = vi.fn(async () => ({
      status: 'FAILED' as const,
      errorRetryable: true,
      errorMessage: 'provider rate limited',
      errorRetryAfterMs: 15_000,
    }));
    const handler = createProductionAutomationJobHandlers({
      executeDiscoveryRun: executeDiscoveryRun as never,
    }).get('DISCOVER_JOBS')!;

    await expect(handler(context())).rejects.toMatchObject({
      name: 'AutomationJobRetryError',
      message: 'provider rate limited',
      retryAfterMs: 15_000,
    });
    expect(executeDiscoveryRun).toHaveBeenCalledWith(
      'user',
      'run',
      undefined,
      expect.any(AbortSignal),
      {
        automationJobId: 'automation-job',
        workerId: 'worker',
        deliveryGeneration: 2,
        dispatchAttempt: 1,
      },
    );
  });

  it('validates a malformed discovery retry hint at the structured boundary', async () => {
    const executeDiscoveryRun = vi.fn(async () => ({
      status: 'PARTIAL' as const,
      errorRetryable: true,
      errorMessage: null,
      errorRetryAfterMs: Number.POSITIVE_INFINITY,
    }));
    const handler = createProductionAutomationJobHandlers({
      executeDiscoveryRun: executeDiscoveryRun as never,
    }).get('DISCOVER_JOBS')!;

    try {
      await handler(context());
      throw new Error('Expected handler to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationJobRetryError);
      expect((error as AutomationJobRetryError).retryAfterMs).toBeNull();
    }
  });

  it('rethrows an infrastructure abort instead of treating it as user cancellation', async () => {
    const abort = new AutomationJobRetryError('lease renewal failed');
    const controller = new AbortController();
    controller.abort(abort);
    const executeDiscoveryRun = vi.fn(async () => ({
      status: 'CANCELLED' as const,
      errorRetryable: false,
      errorMessage: 'Discovery execution was cancelled',
      errorRetryAfterMs: null,
    }));
    const handler = createProductionAutomationJobHandlers({
      executeDiscoveryRun: executeDiscoveryRun as never,
    }).get('DISCOVER_JOBS')!;

    await expect(handler({ ...context(), signal: controller.signal })).rejects.toBe(abort);
  });

  it('returns normally for explicit durable user cancellation', async () => {
    const executeDiscoveryRun = vi.fn(async () => ({
      status: 'CANCELLED' as const,
      errorRetryable: false,
      errorMessage: 'Discovery run was cancelled by the user',
      errorRetryAfterMs: null,
    }));
    const handlerContext = context();
    const handler = createProductionAutomationJobHandlers({
      executeDiscoveryRun: executeDiscoveryRun as never,
    }).get('DISCOVER_JOBS')!;

    await expect(handler(handlerContext)).resolves.toBeUndefined();
    expect(handlerContext.heartbeat).toHaveBeenCalledTimes(2);
  });
});
