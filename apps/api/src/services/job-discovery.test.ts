import { describe, expect, it, vi } from 'vitest';
import { DiscoveryError } from '@jobagent/job-engine';
import { canonicalDiscoveryJobIdentity, classifyDiscoveryFailure, createAdapterExecutor, validatePaging } from './job-discovery';
import { discoveryRunsAccepted, discoveryRunsListed } from '../routes/jobs';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';

describe('job discovery service', () => {
  it('classifies retryable adapter failures into durable error classes', () => {
    const rateLimited = Object.assign(
      new DiscoveryError('http', 'limited', 'lever', 429),
      { retryAfterMs: 2500 },
    );
    expect(classifyDiscoveryFailure(rateLimited)).toMatchObject({
      errorClass: 'RATE_LIMITED',
      errorCode: 'DISCOVERY_HTTP',
      errorRetryable: true,
      errorRetryAfterMs: 2500,
    });
    expect(classifyDiscoveryFailure(Object.assign(new Error('bad hint'), { retryAfterMs: -1 })))
      .toMatchObject({ errorRetryAfterMs: null });
    expect(classifyDiscoveryFailure(new DiscoveryError('timeout', 'slow', 'ashby'))).toMatchObject({
      errorClass: 'TIMEOUT',
      errorRetryable: true,
    });
    expect(classifyDiscoveryFailure(new DiscoveryError('aborted', 'stopped', 'greenhouse'))).toMatchObject({
      errorClass: 'CANCELLED',
      errorRetryable: false,
    });
  });

  it('qualifies provider identity by account without ambiguous separators', () => {
    expect(canonicalDiscoveryJobIdentity('account-a', 'same-id'))
      .not.toBe(canonicalDiscoveryJobIdentity('account-b', 'same-id'));
    expect(canonicalDiscoveryJobIdentity('a:b', 'c'))
      .not.toBe(canonicalDiscoveryJobIdentity('a', 'b:c'));
  });

  it('rejects malformed paging that cannot make progress', () => {
    expect(() => validatePaging('GREENHOUSE', 'cursor-a', {
      jobs: [], page: { pageSize: 100, returned: 0, hasMore: true, nextCursor: 'cursor-a' },
    })).toThrow('invalid paging metadata');
    expect(() => validatePaging('LEVER', undefined, {
      jobs: [], page: { pageSize: 100, returned: 0, hasMore: true },
    })).toThrow('invalid paging metadata');
  });

  it('does not accept non-finite retry hints', () => {
    expect(classifyDiscoveryFailure(Object.assign(new Error('bad hint'), { retryAfterMs: Infinity })))
      .toMatchObject({ errorRetryAfterMs: null });
  });

  it('uses the exact POST and GET response envelopes', () => {
    const runs = [{ id: 'run-1', status: 'PENDING' }];
    expect(discoveryRunsAccepted(runs)).toEqual({ success: true, data: { runs } });
    expect(discoveryRunsListed(runs)).toEqual({ success: true, data: runs });
  });

  it('registers and delegates DISCOVER_JOBS with worker heartbeats', async () => {
    const execute = vi.fn().mockResolvedValue({});
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const handlers = createProductionAutomationJobHandlers({ executeDiscoveryRun: execute });

    expect([...handlers.keys()]).toEqual(['ANALYZE_JOB', 'MATCH_JOB', 'TAILOR_RESUME', 'EVALUATE_ATS', 'EVALUATE_APPLICATION_QUALITY', 'COMPLETE_GREENHOUSE_APPLICATION', 'COMPLETE_LEVER_APPLICATION', 'EXECUTE_AUTHORIZED_SUBMISSION', 'EMAIL_OUTCOME', 'VERIFY_SUBMISSION_CONFIRMATION', 'RESUME_APPLICATION_AFTER_VERIFICATION', 'DISCOVER_JOBS']);
    await handlers.get('DISCOVER_JOBS')!({
      automationJobId: 'automation-1', userId: 'user-1', type: 'DISCOVER_JOBS',
      payload: { runId: 'run-1' }, payloadVersion: 1, correlationId: 'run-1',
      deliveryGeneration: 1, attempt: 1,
      workerId: 'worker-1', signal: new AbortController().signal, heartbeat,
    });

    expect(execute).toHaveBeenCalledWith(
      'user-1', 'run-1', undefined, expect.any(AbortSignal),
      { automationJobId: 'automation-1', workerId: 'worker-1', deliveryGeneration: 1, dispatchAttempt: 1 },
    );
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it('signals worker retry for transient failed or partial results', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 'FAILED', errorRetryable: true, errorMessage: 'provider unavailable',
    });
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const handler = createProductionAutomationJobHandlers({ executeDiscoveryRun: execute }).get('DISCOVER_JOBS')!;

    await expect(handler({
      automationJobId: 'automation-1', userId: 'user-1', type: 'DISCOVER_JOBS',
      payload: { runId: 'run-1' }, payloadVersion: 1, correlationId: 'run-1',
      deliveryGeneration: 1, attempt: 1,
      workerId: 'worker-1', signal: new AbortController().signal, heartbeat,
    })).rejects.toThrow('provider unavailable');
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('completes nonretryable terminal discovery work without signaling retry', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 'FAILED', errorRetryable: false, errorMessage: 'invalid response',
    });
    const handler = createProductionAutomationJobHandlers({ executeDiscoveryRun: execute }).get('DISCOVER_JOBS')!;
    await expect(handler({
      automationJobId: 'automation-1', userId: 'user-1', type: 'DISCOVER_JOBS',
      payload: { runId: 'run-1' }, payloadVersion: 1, correlationId: 'run-1',
      deliveryGeneration: 1, attempt: 1,
      workerId: 'worker-1', signal: new AbortController().signal, heartbeat: async () => undefined,
    })).resolves.toBeUndefined();
  });

  it('rejects malformed discovery work without delegation', async () => {
    const execute = vi.fn();
    const handler = createProductionAutomationJobHandlers({ executeDiscoveryRun: execute }).get('DISCOVER_JOBS')!;
    await expect(handler({
      automationJobId: 'automation-1', userId: 'user-1', type: 'DISCOVER_JOBS', payload: {},
      payloadVersion: 1, correlationId: 'run-1', deliveryGeneration: 1, attempt: 1, workerId: 'worker-1',
      signal: new AbortController().signal, heartbeat: async () => undefined,
    })).rejects.toThrow('runId is required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes an Ashby discovery page through an injected fetch', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [{
      id: 'ash-1', title: 'Engineer', location: 'Remote', descriptionPlain: 'Build systems',
      jobUrl: 'https://jobs.ashbyhq.com/acme/ash-1', applyUrl: 'https://jobs.ashbyhq.com/acme/ash-1/application',
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const page = await createAdapterExecutor(fetch).discover({
      source: 'ASHBY', sourceAccount: 'acme', pageSize: 100,
    });

    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]).toMatchObject({ source: 'ashby', sourceJobId: 'ash-1', company: 'acme' });
    expect(page.page.hasMore).toBe(false);
  });
});
