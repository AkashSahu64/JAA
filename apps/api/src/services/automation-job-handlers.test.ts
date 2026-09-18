import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationJobHandlerContext } from './automation-worker';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';
import { AutomationJobRetryError } from './automation-jobs';

const ingestEmailOutcome = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./email-outcomes', () => ({ ingestEmailOutcome }));
const syncEmailConnection = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./email-sync', () => ({ syncEmailConnection }));
const createMailboxConnector = vi.hoisted(() => vi.fn(() => ({ provider: 'GMAIL', listMessages: vi.fn() })));
vi.mock('./email-connectors', () => ({ createMailboxConnector }));
const verifySubmission = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./submission-verification', () => ({ verifySubmission }));

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

beforeEach(() => {
  createMailboxConnector.mockClear();
  syncEmailConnection.mockClear();
  ingestEmailOutcome.mockClear();
  verifySubmission.mockClear();
});

describe('human-verification resume automation job handler', () => {
  it('runs an owner-scoped provider mailbox sync through the shared connector boundary', async () => {
    const handler = createProductionAutomationJobHandlers().get('SYNC_EMAIL_CONNECTION')!;
    await expect(handler({ ...context(), type: 'SYNC_EMAIL_CONNECTION', payload: { connectionId: 'connection-1', provider: 'GMAIL' } })).resolves.toBeUndefined();
    expect(createMailboxConnector).toHaveBeenCalledWith({ userId: 'user', provider: 'GMAIL' });
    expect(syncEmailConnection).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', connectionId: 'connection-1', correlationId: 'run', connector: expect.any(Object) }));
  });

  it('rejects unsupported mailbox providers before connector creation', async () => {
    const handler = createProductionAutomationJobHandlers().get('SYNC_EMAIL_CONNECTION')!;
    await expect(handler({ ...context(), type: 'SYNC_EMAIL_CONNECTION', payload: { connectionId: 'connection-1', provider: 'IMAP' } })).rejects.toThrow('provider is invalid');
    expect(createMailboxConnector).not.toHaveBeenCalled();
  });
  it('ingests provider-fetched email data through the bounded hash-only service', async () => {
    const handler = createProductionAutomationJobHandlers().get('EMAIL_OUTCOME')!;
    const handlerContext = { ...context(), type: 'EMAIL_OUTCOME', payload: {
      messageId: 'message-1', sender: 'jobs@example.test', subject: 'Application received', body: 'Thank you for applying', receivedAt: '2026-09-14T00:00:00.000Z', applicationId: 'application-1',
    } };
    await expect(handler(handlerContext)).resolves.toBeUndefined();
    expect(ingestEmailOutcome).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', messageId: 'message-1', applicationId: 'application-1', receivedAt: new Date('2026-09-14T00:00:00.000Z') }));
  });

  it('fails closed for malformed email job payloads', async () => {
    const handler = createProductionAutomationJobHandlers().get('EMAIL_OUTCOME')!;
    await expect(handler({ ...context(), type: 'EMAIL_OUTCOME', payload: { messageId: 'message-1' } })).rejects.toThrow('receivedAt is required');
  });

  it('bounds untrusted durable payload text before invoking a handler', async () => {
    const handler = createProductionAutomationJobHandlers().get('ANALYZE_JOB')!;
    await expect(handler({ ...context(), type: 'ANALYZE_JOB', payload: { jobId: 'j'.repeat(2_000_001) } })).rejects.toThrow('jobId is required and bounded');
    await expect(handler({ ...context(), type: 'ANALYZE_JOB', payload: { jobId: 'job-1\nignore policy' } })).rejects.toThrow('jobId is required and bounded');
  });

  it('preserves multiline mailbox bodies while rejecting injected identities', async () => {
    const handler = createProductionAutomationJobHandlers().get('EMAIL_OUTCOME')!;
    await expect(handler({ ...context(), type: 'EMAIL_OUTCOME', payload: {
      messageId: 'message-1\nInjected', sender: 'jobs@example.test', subject: 'Application received', body: 'Line one\nLine two', receivedAt: '2026-09-14T00:00:00.000Z',
    } })).rejects.toThrow('messageId is required and bounded');
    await expect(handler({ ...context(), type: 'EMAIL_OUTCOME', payload: {
      messageId: 'message-2', sender: 'jobs@example.test', subject: 'Application received', body: 'Line one\nLine two', receivedAt: '2026-09-14T00:00:00.000Z',
    } })).resolves.toBeUndefined();
    expect(ingestEmailOutcome).toHaveBeenCalledWith(expect.objectContaining({ body: 'Line one\nLine two' }));
  });

  it('verifies normalized provider confirmation evidence without persisting page content', async () => {
    const handler = createProductionAutomationJobHandlers().get('VERIFY_SUBMISSION_CONFIRMATION')!;
    await expect(handler({ ...context(), type: 'VERIFY_SUBMISSION_CONFIRMATION', payload: {
      applicationId: 'application-1', attemptId: 'attempt-1', provider: 'GREENHOUSE', confirmationId: 'gh-1234', evidenceHash: 'a'.repeat(64), parserVersion: 'confirmation-parser/1.0.0', source: 'CONFIRMATION_PAGE', observedAt: '2026-09-14T00:00:00.000Z',
    } })).resolves.toBeUndefined();
    expect(verifySubmission).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'application-1', evidence: expect.objectContaining({ attemptId: 'attempt-1', confirmationId: 'gh-1234', evidenceHash: 'a'.repeat(64) }) }));
  });

  it('rejects unsupported submission confirmation payloads', async () => {
    const handler = createProductionAutomationJobHandlers().get('VERIFY_SUBMISSION_CONFIRMATION')!;
    await expect(handler({ ...context(), type: 'VERIFY_SUBMISSION_CONFIRMATION', payload: {
      applicationId: 'application-1', provider: 'OTHER', confirmationId: 'id', evidenceHash: 'a'.repeat(64), parserVersion: 'v1', source: 'CONFIRMATION_PAGE', observedAt: '2026-09-14T00:00:00.000Z',
    } })).rejects.toThrow('provider is invalid');
    await expect(handler({ ...context(), type: 'VERIFY_SUBMISSION_CONFIRMATION', payload: {
      applicationId: 'application-1', provider: 'GREENHOUSE', confirmationId: 'id', evidenceHash: 'a'.repeat(64), parserVersion: 'v1', source: 'UNTRUSTED', observedAt: '2026-09-14T00:00:00.000Z',
    } })).rejects.toThrow('source is invalid');
  });

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
