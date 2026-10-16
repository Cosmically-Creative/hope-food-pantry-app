import { Temporal } from '@js-temporal/polyfill';
import { todayInZone } from './time.js';

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type CalendarDay = {
  date: string;
  day: number;
  weekday: string;
  inMonth: boolean;
  label: string;
};

export type CalendarMonth = {
  id: string;
  label: string;
  weeks: CalendarDay[][];
};

/** Sunday-first month grid. Leading and trailing days belong to the neighboring months. */
export function calendarMonth(monthId: string): CalendarMonth {
  const month = Temporal.PlainYearMonth.from(monthId);
  const first = month.toPlainDate({ day: 1 });
  const last = month.toPlainDate({ day: month.daysInMonth });
  const start = first.subtract({ days: first.dayOfWeek % 7 });
  const weeks: CalendarDay[][] = [];
  let cursor = start;
  while (Temporal.PlainDate.compare(cursor, last) <= 0) {
    const days: CalendarDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      days.push(toCalendarDay(cursor, month));
      cursor = cursor.add({ days: 1 });
    }
    weeks.push(days);
  }
  const monthName = MONTH_LONG[month.month - 1];
  if (!monthName) throw new Error(`${monthId} is not a month.`);
  return {
    id: month.toString(),
    label: `${monthName} ${month.year}`,
    weeks,
  };
}

/** Months that contain at least one shift, earliest first. */
export function monthsCovering(dates: string[]): string[] {
  return [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
}

const MONTH_ID = /^\d{4}-\d{2}$/;

export function parseMonthId(value: string | undefined): string | null {
  if (!value || !MONTH_ID.test(value)) return null;
  try {
    return Temporal.PlainYearMonth.from(value).toString();
  } catch {
    return null;
  }
}

/** The requested month when it has shifts, otherwise the month of today or the nearest later month. */
export function chooseCalendarMonth(requested: string | undefined, dates: string[], today: string): string {
  const months = monthsCovering(dates);
  const parsed = parseMonthId(requested);
  if (parsed && months.includes(parsed)) return parsed;
  const todayMonth = today.slice(0, 7);
  if (months.includes(todayMonth)) return todayMonth;
  return months.find((month) => month >= todayMonth) ?? months.at(-1) ?? todayMonth;
}

export function monthStep(current: string, dates: string[]): { previous: string | null; next: string | null } {
  const months = monthsCovering(dates);
  const index = months.indexOf(current);
  if (index === -1) {
    return {
      previous: [...months].reverse().find((month) => month < current) ?? null,
      next: months.find((month) => month > current) ?? null,
    };
  }
  return {
    previous: index > 0 ? (months[index - 1] ?? null) : null,
    next: months[index + 1] ?? null,
  };
}

export function calendarToday(timeZone: string, nowUtc: string): string {
  return todayInZone(timeZone, Temporal.Instant.from(nowUtc));
}

function toCalendarDay(date: Temporal.PlainDate, month: Temporal.PlainYearMonth): CalendarDay {
  const weekdayName = WEEKDAY_LONG[date.dayOfWeek % 7];
  const monthName = MONTH_LONG[date.month - 1];
  if (!weekdayName || !monthName) throw new Error(`${date.toString()} is not a calendar day.`);
  return {
    date: date.toString(),
    day: date.day,
    weekday: weekdayName,
    inMonth: date.year === month.year && date.month === month.month,
    label: `${weekdayName}, ${monthName} ${date.day}, ${date.year}`,
  };
}
