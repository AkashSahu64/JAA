import { describe, expect, it } from 'vitest';
import { bullPriority, deadLetterQueueName, queueForJobType } from './names';
import { queueJobId, validateEnqueueAutomationJobInput } from './registry';
import { MAX_RETRY_DELAY_MS, retryDelayMs, retryJitter } from './worker';

describe('automation queue semantics', () => {
  it.each([
    ['DISCOVER_JOBS', 'discovery'],
    ['SEARCH_SOURCE', 'discovery'],
    ['ANALYZE_MATCH', 'analysis'],
    ['TAILOR_RESUME', 'analysis'],
    ['DOCUMENT_RENDER', 'documents'],
    ['RESUME_UPLOAD', 'documents'],
    ['APPLICATION_FILL', 'applications'],
    ['VERIFY_SUBMISSION', 'applications'],
    ['NOTIFY_USER', 'notifications'],
    ['EMAIL_OUTCOME', 'notifications'],
    ['LEASE_RECONCILIATION', 'maintenance'],
  ] as const)('routes %s to %s', (type, expected) => {
    expect(queueForJobType(type)).toBe(expected);
  });

  it('uses BullMQ-compatible attempt-specific identifiers', () => {
    expect(queueJobId('job-id', 2)).toBe('job-id-2');
    expect(queueJobId('job-id', 2)).not.toContain(':');
    expect(deadLetterQueueName('applications')).toBe('applications.dead-letter');
  });

  it('maps larger application priorities to smaller BullMQ priorities', () => {
    expect(bullPriority(100)).toBeLessThan(bullPriority(10));
    expect(bullPriority(2_000_000)).toBe(1);
    expect(bullPriority(-2_000_000)).toBe(2_000_001);
  });

  it('keeps exponential retry jitter bounded and deterministic per delivery', () => {
    const jitter = retryJitter('job-id', 1);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(1);
    expect(retryJitter('job-id', 1)).toBe(jitter);
    expect(retryDelayMs(1, 1_000, 0)).toBe(750);
    expect(retryDelayMs(1, 1_000, 1)).toBe(1_250);
    expect(retryDelayMs(2, 1_000, 0.5)).toBe(2_000);
  });

  it('keeps overflow and malformed retry inputs fail-safe', () => {
    expect(retryDelayMs(10_000, 1_000, 0.5)).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(1, 1_000, Number.NaN)).toBe(1_000);
    expect(() => retryDelayMs(0)).toThrow('positive integer');
    expect(() => retryDelayMs(1, 0)).toThrow('positive integer');
  });

  it('rejects malformed queue envelopes before they reach BullMQ', () => {
    const valid = {
      automationJobId: 'job-1', type: 'APPLICATION_SUBMIT', correlationId: 'corr-1',
      payloadVersion: 1, deliveryGeneration: 1, dispatchAttempt: 1,
      priority: 0, availableAt: new Date(), maxAttempts: 3,
    };
    expect(() => validateEnqueueAutomationJobInput(valid)).not.toThrow();
    expect(() => validateEnqueueAutomationJobInput({ ...valid, availableAt: new Date(Number.NaN) })).toThrow('availableAt');
    expect(() => validateEnqueueAutomationJobInput({ ...valid, dispatchAttempt: 0 })).toThrow('dispatchAttempt');
    expect(() => validateEnqueueAutomationJobInput({ ...valid, correlationId: 'corr\nforged' })).toThrow('correlationId');
  });
});
