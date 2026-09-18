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

  it.each([
    ['USER_PROFILE', 'not-a-profile-reference'],
    ['COVER_LETTER', 'not-a-cover-letter-reference'],
  ] as const)('rejects a scalar value declared as %s before entering the tenant transaction', async (source, value) => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question-1', value, source,
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });

  it('rejects an unknown profile key even when its shape is otherwise valid', async () => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question-1',
      value: { profileKey: 'adminSecret' }, source: 'USER_PROFILE',
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });

  it('rejects a profile reference whose provenance names a different key', async () => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question-1',
      value: { profileKey: 'email' }, source: 'USER_PROFILE', provenance: { source: 'USER_PROFILE', profileKey: 'phone' },
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });

  it('rejects control characters in durable answer identities', async () => {
    await expect((await import('./application-answers')).saveApplicationAnswerDraft({
      userId: 'user-1', applicationId: 'application-1', questionId: 'question\n1',
      value: 'answer', source: 'USER_INPUT',
    })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ApplicationAnswerError>);
  });
});
