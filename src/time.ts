import { Temporal } from '@js-temporal/polyfill';

/**
 * Node 22 does not ship a stable Temporal API. @js-temporal/polyfill is the
 * timezone library for this app. It can reject a local time that falls in a
 * daylight-saving gap or overlap instead of silently moving it.
 *
 * Database instants use formatUtc(): YYYY-MM-DDTHH:mm:ss.SSSZ
 * Local dates stay YYYY-MM-DD. Local times stay HH:MM.
 * Weekday 0 is Sunday and weekday 6 is Saturday.
 */

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export class LocalTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalTimeError';
  }
}

export type ZonedClock = {
  date: string;
  time24: string;
  timeLabel: string;
  weekday: number;
  abbreviation: string;
  timeZone: string;
  dateLabel: string;
  label: string;
};

export function isUtcInstant(value: string): boolean {
  return UTC_INSTANT.test(value);
}

export function assertUtcInstant(value: string): string {
  if (!isUtcInstant(value)) {
    throw new LocalTimeError('Expected a UTC instant like 2026-01-15T15:00:00.000Z.');
  }
  return value;
}

export function assertValidTimeZone(timeZone: string): string {
  try {
    Temporal.Instant.from('2020-01-01T00:00:00Z').toZonedDateTimeISO(timeZone);
    return timeZone;
  } catch {
    throw new LocalTimeError(`${timeZone} is not a recognized IANA time zone.`);
  }
}

export function formatUtc(instant: Temporal.Instant): string {
  const zoned = instant.toZonedDateTimeISO('UTC');
  return `${pad(zoned.year, 4)}-${pad(zoned.month)}-${pad(zoned.day)}T${pad(zoned.hour)}:${pad(zoned.minute)}:${pad(zoned.second)}.${pad(zoned.millisecond, 3)}Z`;
}

export function nowUtc(now: Temporal.Instant = Temporal.Now.instant()): string {
  return formatUtc(now);
}

export function localToUtc(date: string, time: string, timeZone: string): string {
  assertValidTimeZone(timeZone);
  assertCalendarDate(date);
  if (!LOCAL_TIME.test(time)) {
    throw new LocalTimeError(`${time} is not a local time. Use 24-hour HH:MM, such as 09:00 or 17:30.`);
  }
  const parts = parseDateTime(date, time);
  try {
    const zoned = Temporal.ZonedDateTime.from(
      {
        timeZone,
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: 0,
        millisecond: 0,
      },
      { disambiguation: 'reject' },
    );
    return assertUtcInstant(formatUtc(zoned.toInstant()));
  } catch (err) {
    if (err instanceof LocalTimeError) throw err;
    const kind = classifyLocalTime(parts, timeZone);
    const shown = `${date} ${time} (${clockLabel(time)})`;
    if (kind === 'gap') {
      throw new LocalTimeError(
        `${shown} does not exist in ${timeZone}. Daylight saving time skips that clock time. Choose a different local time.`,
      );
    }
    if (kind === 'overlap') {
      throw new LocalTimeError(
        `${shown} happens twice in ${timeZone} because daylight saving time repeats that hour. Choose a local time outside the repeated hour.`,
      );
    }
    throw new LocalTimeError(`${shown} is not a valid local time in ${timeZone}.`);
  }
}

export function assertSameDayShift(startLocal: string, endLocal: string): void {
  if (!LOCAL_TIME.test(startLocal) || !LOCAL_TIME.test(endLocal)) {
    throw new LocalTimeError('Use local times in 24-hour HH:MM form, such as 09:00 or 17:30.');
  }
  if (endLocal <= startLocal) {
    throw new LocalTimeError(
      'Shifts must start and end on the same day, with the end time after the start. Overnight shifts are not available yet.',
    );
  }
}

export function localShiftToUtc(
  date: string,
  startLocal: string,
  endLocal: string,
  timeZone: string,
): { startsAtUtc: string; endsAtUtc: string } {
  assertSameDayShift(startLocal, endLocal);
  const startsAtUtc = localToUtc(date, startLocal, timeZone);
  const endsAtUtc = localToUtc(date, endLocal, timeZone);
  if (endsAtUtc <= startsAtUtc) {
    throw new LocalTimeError('The shift end must be after the start.');
  }
  return { startsAtUtc, endsAtUtc };
}

export function formatInstantInZone(utc: string, timeZone: string): ZonedClock {
  assertUtcInstant(utc);
  assertValidTimeZone(timeZone);
  const instant = Temporal.Instant.from(utc);
  const zoned = instant.toZonedDateTimeISO(timeZone);
  const date = `${pad(zoned.year, 4)}-${pad(zoned.month)}-${pad(zoned.day)}`;
  const time24 = `${pad(zoned.hour)}:${pad(zoned.minute)}`;
  const timeLabel = clockLabel(time24);
  const weekday = zoned.dayOfWeek % 7;
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(instant.epochMilliseconds));
  const abbreviation = timeZoneAbbreviation(instant, timeZone);
  return {
    date,
    time24,
    timeLabel,
    weekday,
    abbreviation,
    timeZone,
    dateLabel,
    label: `${dateLabel}, ${timeLabel} ${abbreviation}`,
  };
}

export function addLocalDays(date: string, days: number): string {
  assertCalendarDate(date);
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function weekdayIndex(date: string, timeZone: string): number {
  return formatInstantInZone(localToUtc(date, '12:00', timeZone), timeZone).weekday;
}

export function todayInZone(timeZone: string, now: Temporal.Instant = Temporal.Now.instant()): string {
  assertValidTimeZone(timeZone);
  const zoned = now.toZonedDateTimeISO(timeZone);
  return `${pad(zoned.year, 4)}-${pad(zoned.month)}-${pad(zoned.day)}`;
}

function assertCalendarDate(date: string): void {
  if (!LOCAL_DATE.test(date)) {
    throw new LocalTimeError(`${date} is not a real calendar date. Use YYYY-MM-DD.`);
  }
  try {
    Temporal.PlainDate.from(date);
  } catch {
    throw new LocalTimeError(`${date} is not a real calendar date.`);
  }
}

function parseDateTime(date: string, time: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const dateMatch = LOCAL_DATE.exec(date);
  const timeMatch = LOCAL_TIME.exec(time);
  if (!dateMatch || !timeMatch) {
    throw new LocalTimeError(`${date} ${time} is not a valid local date and time.`);
  }
  return {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
}

function classifyLocalTime(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): 'gap' | 'overlap' | 'unique' {
  const earlier = zonedAt(parts, timeZone, 'earlier');
  const later = zonedAt(parts, timeZone, 'later');
  const earlierMatches = sameClock(earlier, parts);
  const laterMatches = sameClock(later, parts);
  if (earlierMatches && laterMatches && earlier.offset !== later.offset) return 'overlap';
  if (!earlierMatches && !laterMatches) return 'gap';
  return 'unique';
}

function zonedAt(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
  disambiguation: 'earlier' | 'later',
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: 0,
      millisecond: 0,
    },
    { disambiguation },
  );
}

function sameClock(
  zoned: Temporal.ZonedDateTime,
  parts: { hour: number; minute: number },
): boolean {
  return zoned.hour === parts.hour && zoned.minute === parts.minute;
}

function clockLabel(time: string): string {
  const match = LOCAL_TIME.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${pad(minute)} ${suffix}`;
}

function timeZoneAbbreviation(instant: Temporal.Instant, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
    hour: 'numeric',
  }).formatToParts(new Date(instant.epochMilliseconds));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value;
  return name && name.length > 0 ? name : timeZone;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}
