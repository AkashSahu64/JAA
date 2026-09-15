import { describe, expect, it } from 'vitest';
import { ApplicationQualityError, profileCalendarDay } from './application-quality';

describe('application quality budget calendar', () => {
  it('uses the profile local calendar day instead of UTC', () => {
    const instant = new Date('2026-09-15T01:30:00.000Z');
    expect(profileCalendarDay(instant, 'America/Los_Angeles')).toEqual(new Date('2026-09-14T00:00:00.000Z'));
    expect(profileCalendarDay(instant, 'Asia/Kolkata')).toEqual(new Date('2026-09-15T00:00:00.000Z'));
  });

  it('fails closed for invalid quality time zones and timestamps', () => {
    expect(() => profileCalendarDay(new Date('2026-09-15T00:00:00.000Z'), 'Not/AZone')).toThrow(ApplicationQualityError);
    expect(() => profileCalendarDay(new Date('invalid'), 'UTC')).toThrow(ApplicationQualityError);
  });
});
