import { describe, expect, it } from 'vitest';
import { validateProfile } from './profile';

describe('candidate profile input validation', () => {
  it('accepts bounded candidate profile data', () => {
    expect(validateProfile({ fullName: 'Ada Lovelace', targetRoles: ['Platform Engineer'], yearsOfExperience: 10 })).toBeNull();
  });

  it.each([
    { fullName: 'Ada\nLovelace' },
    { professionalSummary: 'x'.repeat(20_001) },
    { targetRoles: ['x'.repeat(201)] },
    { targetRoles: Array.from({ length: 101 }, () => 'Engineer') },
  ])('rejects unsafe or oversized candidate profile data: %j', override => {
    expect(validateProfile({ ...override })).not.toBeNull();
  });
});
