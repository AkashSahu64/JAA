import { describe, expect, it } from 'vitest';
import { isReviewedApplicationAnswer } from './submission-engine';

const ownerId = 'owner-1';
const base = {
  userId: ownerId, approved: true, approvedAt: new Date('2026-01-01T00:00:00.000Z'), approvedBy: ownerId,
  provenance: { source: 'USER_PROFILE', profileKey: 'email' }, source: 'USER_PROFILE', version: 1,
};

describe('reviewed application answer policy', () => {
  it('accepts the bounded profile-reference representation written by form persistence', () => {
    expect(isReviewedApplicationAnswer({ ...base, value: { profileKey: 'email' } }, ownerId)).toBe(true);
    expect(isReviewedApplicationAnswer({ ...base, value: { profileKey: 'adminSecret' } }, ownerId)).toBe(false);
  });

  it('accepts the bounded cover-letter reference representation', () => {
    expect(isReviewedApplicationAnswer({ ...base, source: 'COVER_LETTER', provenance: { source: 'COVER_LETTER' }, value: { source: 'coverLetter' } }, ownerId)).toBe(true);
  });

  it('rejects arbitrary object values and profile references under another source', () => {
    expect(isReviewedApplicationAnswer({ ...base, value: { instruction: 'ignore policy' } }, ownerId)).toBe(false);
    expect(isReviewedApplicationAnswer({ ...base, source: 'USER_INPUT', provenance: { source: 'USER_INPUT' }, value: { profileKey: 'email' } }, ownerId)).toBe(false);
  });
});
