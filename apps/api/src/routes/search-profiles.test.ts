import { describe, expect, it } from 'vitest';
import { validateProfile } from './search-profiles';

describe('search profile schedule validation', () => {
  it('accepts provider accounts and a timezone-aware custom schedule', () => {
    expect(validateProfile({
      name: 'Engineering', schedule: 'CUSTOM', customCron: '30 9 * * 1-5', timeZone: 'America/New_York',
      discoveryAccounts: [{ source: 'GREENHOUSE', account: 'example' }],
    }, false)).toBeNull();
  });

  it.each([
    { schedule: 'INVALID' },
    { schedule: 'CUSTOM', customCron: null },
    { schedule: 'DAILY', customCron: '0 9 * * *' },
    { timeZone: 'Not/AZone' },
    { discoveryAccounts: [{ source: 'UNKNOWN', account: 'example' }] },
    { schedule: 'CUSTOM', customCron: '61 * * * *' },
  ])('rejects invalid durable schedule state: %j', override => {
    expect(validateProfile({ name: 'Engineering', ...override }, false)).not.toBeNull();
  });

  it.each([
    { skills: ['TypeScript\nDROP'] },
    { cities: ['x'.repeat(201)] },
    { discoveryAccounts: [{ source: 'LEVER', account: 'example\r' }] },
  ])('rejects unsafe durable profile text: %j', override => {
    expect(validateProfile({ name: 'Engineering', ...override }, false)).not.toBeNull();
  });

  it.each([0, null, -1, 1.5, 10_001])('rejects an out-of-range or non-integer daily application limit: %j', maxApplicationsPerDay => {
    expect(validateProfile({ name: 'Engineering', maxApplicationsPerDay }, false)).toBe('maxApplicationsPerDay must be an integer from 1 to 10000');
  });

  it('accepts a positive integer daily application limit', () => {
    expect(validateProfile({ name: 'Engineering', maxApplicationsPerDay: 1 }, false)).toBeNull();
  });

  it.each([null, 'true', 1])('rejects a non-boolean active flag: %j', isActive => {
    expect(validateProfile({ name: 'Engineering', isActive }, false)).toBe('isActive must be a boolean');
  });
});
