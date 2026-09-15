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
});
