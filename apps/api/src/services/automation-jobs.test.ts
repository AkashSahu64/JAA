import { describe, expect, it } from 'vitest';
import {
  AutomationJobError,
  AutomationJobRetryError,
  effectiveAutomationJobRetryDelayMs,
  validateAutomationJobNow,
  validateAutomationJobMaxAttempts,
} from './automation-jobs';

describe('automation job errors', () => {
  it('exposes stable lifecycle error codes', () => {
    const error = new AutomationJobError('LEASE_LOST', 'lost');
    expect(error.name).toBe('AutomationJobError');
    expect(error.code).toBe('LEASE_LOST');
  });

  it('preserves only validated structured provider retry hints', () => {
    expect(new AutomationJobRetryError('limited', 15_000)).toMatchObject({
      name: 'AutomationJobRetryError',
      message: 'limited',
      retryAfterMs: 15_000,
    });
    expect(new AutomationJobRetryError('invalid', Number.POSITIVE_INFINITY).retryAfterMs).toBeNull();
    expect(new AutomationJobRetryError('fractional', 1.5).retryAfterMs).toBeNull();
  });

  it('uses the greater of local backoff and a validated provider hint', () => {
    expect(effectiveAutomationJobRetryDelayMs(2_000, 15_000)).toBe(15_000);
    expect(effectiveAutomationJobRetryDelayMs(20_000, 15_000)).toBe(20_000);
    expect(effectiveAutomationJobRetryDelayMs(2_000, -1)).toBe(2_000);
    expect(effectiveAutomationJobRetryDelayMs(2_000, Number.NaN)).toBe(2_000);
  });

  it('rejects invalid local retry delay values', () => {
    expect(() => effectiveAutomationJobRetryDelayMs(0, 15_000)).toThrow('retryDelayMs must be a positive integer');
  });

  it('rejects invalid recovery timestamps before database work', () => {
    expect(() => validateAutomationJobNow(new Date(Number.NaN))).toThrow('now must be a valid Date');
  });

  it('bounds durable retry budgets', () => {
    expect(() => validateAutomationJobMaxAttempts(0)).toThrow('maxAttempts must be a positive integer');
    expect(() => validateAutomationJobMaxAttempts(101)).toThrow('must not exceed 100');
    expect(() => validateAutomationJobMaxAttempts(Number.MAX_SAFE_INTEGER)).toThrow('must not exceed 100');
    expect(() => validateAutomationJobMaxAttempts(100)).not.toThrow();
  });
});
