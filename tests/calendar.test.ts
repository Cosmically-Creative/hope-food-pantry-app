import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { calendarMonth, calendarToday, chooseCalendarMonth, monthStep, monthsCovering, parseMonthId } from '../src/calendar.js';

describe('calendar months', () => {
  it('builds a Sunday-first grid for the month', () => {
    const october = calendarMonth('2026-10');
    expect(october.label).toBe('October 2026');
    expect(october.id).toBe('2026-10');
    const inMonth = october.weeks.flat().filter((day) => day.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]).toMatchObject({ date: '2026-10-01', day: 1, label: 'Thursday, October 1, 2026' });
    expect(inMonth.at(-1)).toMatchObject({ date: '2026-10-31', day: 31 });
    expect(october.weeks[0]?.[0]).toMatchObject({ date: '2026-09-27', inMonth: false });
    expect(october.weeks[0]?.[4]).toMatchObject({ date: '2026-10-01', inMonth: true });
    for (const week of october.weeks) {
      expect(week).toHaveLength(7);
      const start = week[0];
      expect(start).toBeDefined();
      expect(Temporal.PlainDate.from(start?.date ?? '').dayOfWeek).toBe(7);
    }
  });

  it('uses four exact weeks when the month starts on Sunday and ends on Saturday', () => {
    const february = calendarMonth('2026-02');
    expect(february.label).toBe('February 2026');
    expect(february.weeks).toHaveLength(4);
    expect(february.weeks[0]?.[0]).toMatchObject({ date: '2026-02-01', inMonth: true, day: 1 });
    expect(february.weeks[3]?.[6]).toMatchObject({ date: '2026-02-28', inMonth: true, day: 28 });
    expect(february.weeks.flat().every((day) => day.inMonth)).toBe(true);
  });

  it('lists the months that contain shifts, earliest first', () => {
    expect(monthsCovering(['2026-11-04', '2026-10-15', '2026-10-01'])).toEqual(['2026-10', '2026-11']);
  });

  it('chooses one month and the months on either side', () => {
    const dates = ['2026-10-15', '2026-11-04', '2026-12-02'];
    expect(parseMonthId('2026-13')).toBeNull();
    expect(parseMonthId('October')).toBeNull();
    expect(chooseCalendarMonth(undefined, dates, '2026-10-14')).toBe('2026-10');
    expect(chooseCalendarMonth('2026-11', dates, '2026-10-14')).toBe('2026-11');
    expect(chooseCalendarMonth('nope', dates, '2026-10-14')).toBe('2026-10');
    expect(chooseCalendarMonth('2026-09', dates, '2026-10-14')).toBe('2026-10');
    expect(monthStep('2026-11', dates)).toEqual({ previous: '2026-10', next: '2026-12' });
    expect(monthStep('2026-10', dates).previous).toBeNull();
    expect(monthStep('2026-12', dates).next).toBeNull();
  });

  it('reads today in the event time zone', () => {
    expect(calendarToday('America/Chicago', '2026-10-14T18:00:00.000Z')).toBe('2026-10-14');
    expect(calendarToday('America/Chicago', '2026-10-15T04:30:00.000Z')).toBe('2026-10-14');
    expect(calendarToday('America/Chicago', '2026-10-15T05:00:00.000Z')).toBe('2026-10-15');
  });
});
