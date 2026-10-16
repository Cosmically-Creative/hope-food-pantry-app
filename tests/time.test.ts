import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  formatInstantInZone,
  localShiftToUtc,
  localToUtc,
  LocalTimeError,
  weekdayIndex,
} from '../src/time.js';

const ZONE = 'America/Chicago';

describe('local time conversion', () => {
  it('keeps a 9:00 local shift at 9:00 on both sides of daylight saving time', () => {
    const winter = localToUtc('2026-01-15', '09:00', ZONE);
    const summer = localToUtc('2026-07-15', '09:00', ZONE);
    expect(winter).toBe('2026-01-15T15:00:00.000Z');
    expect(summer).toBe('2026-07-15T14:00:00.000Z');
    expect(formatInstantInZone(winter, ZONE).time24).toBe('09:00');
    expect(formatInstantInZone(summer, ZONE).time24).toBe('09:00');
    expect(formatInstantInZone(winter, ZONE).timeLabel).toBe('9:00 AM');
    expect(formatInstantInZone(summer, ZONE).timeLabel).toBe('9:00 AM');
    expect(formatInstantInZone(winter, ZONE).abbreviation).toBe('CST');
    expect(formatInstantInZone(summer, ZONE).abbreviation).toBe('CDT');
    expect(formatInstantInZone(winter, ZONE).label).toContain('9:00 AM CST');
  });

  it('converts the 2026 March and November boundaries without moving 9:00', () => {
    expect(localToUtc('2026-03-07', '09:00', ZONE)).toBe('2026-03-07T15:00:00.000Z');
    expect(localToUtc('2026-03-08', '09:00', ZONE)).toBe('2026-03-08T14:00:00.000Z');
    expect(localToUtc('2026-03-09', '09:00', ZONE)).toBe('2026-03-09T14:00:00.000Z');
    expect(localToUtc('2026-10-31', '09:00', ZONE)).toBe('2026-10-31T14:00:00.000Z');
    expect(localToUtc('2026-11-01', '09:00', ZONE)).toBe('2026-11-01T15:00:00.000Z');
    expect(localToUtc('2026-11-02', '09:00', ZONE)).toBe('2026-11-02T15:00:00.000Z');
    expect(formatInstantInZone('2026-03-08T14:00:00.000Z', ZONE).time24).toBe('09:00');
    expect(formatInstantInZone('2026-11-01T15:00:00.000Z', ZONE).time24).toBe('09:00');
  });

  it('rejects a local time that does not exist or happens twice', () => {
    expect(() => localToUtc('2026-03-08', '02:30', ZONE)).toThrow(LocalTimeError);
    expect(() => localToUtc('2026-03-08', '02:30', ZONE)).toThrow(/does not exist/);
    expect(() => localToUtc('2026-11-01', '01:30', ZONE)).toThrow(/happens twice/);
  });

  it('rejects an impossible calendar date and a reversed shift', () => {
    expect(() => localToUtc('2026-02-31', '09:00', ZONE)).toThrow(/not a real calendar date/);
    expect(() => localShiftToUtc('2026-10-20', '12:00', '09:00', ZONE)).toThrow(/same day/);
    expect(() => localShiftToUtc('2026-10-20', '09:00', '09:00', ZONE)).toThrow(/same day/);
    const shift = localShiftToUtc('2026-10-20', '09:00', '12:00', ZONE);
    expect(shift.endsAtUtc > shift.startsAtUtc).toBe(true);
  });

  it('counts weekdays with Sunday as 0 and adds calendar days', () => {
    expect(weekdayIndex('2026-03-08', ZONE)).toBe(0);
    expect(weekdayIndex('2026-01-15', ZONE)).toBe(4);
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addLocalDays('2026-03-08', 1)).toBe('2026-03-09');
  });
});
