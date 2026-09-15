import { describe, expect, it } from 'vitest';
import { ApplicationAnswerError, decideApplicationAnswer, isValidApplicationAnswerProvenance } from './application-answers';

describe('application answer provenance bounds', () => {
  it('accepts compact structured provenance and rejects oversized metadata', () => {
    expect(isValidApplicationAnswerProvenance({ source: 'USER_INPUT', reviewedBy: 'user-1' })).toBe(true);
    expect(isValidApplicationAnswerProvenance({ source: 'USER_INPUT', detail: 'x'.repeat(8_193) })).toBe(false);
  });

  it('rejects unknown decisions instead of treating them as approval', async () => {
    await expect(decideApplicationAnswer({
      userId: 'user-1', applicationId: 'application-1', answerId: 'answer-1',
      decision: 'MUTATE' as never,
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });

  it('rejects oversized answer values before entering the tenant transaction', async () => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question-1',
      value: 'x'.repeat(20_001), source: 'USER_INPUT',
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });

  it('rejects control characters in durable answer identities', async () => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question\n1',
      value: 'answer', source: 'USER_INPUT',
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });
});
