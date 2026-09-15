import { describe, expect, it } from 'vitest';
import { executeAuthorizedSubmission, isReviewedApplicationAnswer, safeSubmissionFailureMessage, selectReviewedApplicationAnswer, validateProviderExecutionResult } from './submission-engine';

const approvedAt = new Date('2026-09-14T00:00:00.000Z');
const base = {
  userId: 'user-1', approved: true, approvedAt, approvedBy: 'user-1',
  source: 'USER_INPUT', version: 1,
  provenance: { source: 'USER_INPUT' },
};

describe('submission answer approval boundary', () => {
  it('redacts credentials before provider failures enter durable evidence', () => {
    expect(safeSubmissionFailureMessage(new Error('Bearer abc.def password=secret https://example.test/cb?access_token=query-secret\nnext')))
      .toBe('Bearer [REDACTED] password=[REDACTED] https://example.test/cb?access_token=[REDACTED] next');
  });

  it('rejects malformed provider outcomes at the post-execution trust boundary', () => {
    expect(() => validateProviderExecutionResult({ provider: 'OTHER', attemptedAt: new Date() }, 'application-1')).toThrow('unverifiable outcome');
    expect(() => validateProviderExecutionResult({ provider: 'GREENHOUSE', attemptedAt: new Date(), confirmation: { applicationId: 'other', provider: 'GREENHOUSE', observedAt: new Date() } }, 'application-1')).toThrow('inconsistent confirmation');
    expect(() => validateProviderExecutionResult({ provider: 'GREENHOUSE', attemptedAt: new Date(Date.now() + 10 * 60 * 1000) }, 'application-1')).toThrow('unverifiable outcome');
  });

  it('preserves the exact durable attempt identity on provider confirmation evidence', () => {
    expect(() => validateProviderExecutionResult({
      provider: 'GREENHOUSE',
      attemptedAt: new Date(),
      confirmation: { applicationId: 'application-1', provider: 'GREENHOUSE', observedAt: new Date() },
    }, 'application-1')).not.toThrow();
  });

  it('accepts only an owner-approved answer with a valid approval timestamp', () => {
    expect(isReviewedApplicationAnswer(base, 'user-1')).toBe(true);
    expect(isReviewedApplicationAnswer({ ...base, approvedBy: 'other-user' }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, userId: 'other-user' }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, approvedAt: null }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, provenance: { source: 'AI_SUGGESTION' } }, 'user-1')).toBe(false);
  });

  it('rejects approval flags without structured provenance', () => {
    expect(isReviewedApplicationAnswer({ ...base, provenance: null }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, provenance: ['USER_INPUT'] }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, approved: false }, 'user-1')).toBe(false);
  });

  it('rejects malformed persisted approved answer values', () => {
    expect(isReviewedApplicationAnswer({ ...base, value: { injected: true } }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, value: 'x'.repeat(20_001) }, 'user-1')).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, value: ['x'.repeat(501)] }, 'user-1')).toBe(false);
  });

  it('selects the newest reviewed answer without trusting relation order', () => {
    const older = { ...base, answer: 'older', version: 2 };
    const newer = { ...base, answer: 'newer', version: 4, approvedAt: new Date('2026-09-15T00:00:00.000Z') };
    const draft = { ...base, answer: 'draft', version: 5, approved: false };
    expect(selectReviewedApplicationAnswer([draft, older, newer], 'user-1')).toBe(newer);
  });

  it('rejects control-bearing execution identities before any durable claim', async () => {
    await expect(executeAuthorizedSubmission({
      userId: 'user-1', authorizationId: 'auth-1', correlationId: 'corr\n1', workerId: 'worker-1',
    })).rejects.toMatchObject({ code: 'INVALID' });
  });
});
