import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { isWithinSignupWindow } from './signup-window.js';
import { formatInstantInZone, localToUtc, todayInZone } from './time.js';

/** Weekday 0 is Sunday, matching the zoned clock. The public sign-up cards use Wednesday. */
export const WEDNESDAY = 3;

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type PublicShift = {
  id: number;
  role: string;
  startsAtUtc: string;
  endsAtUtc: string;
  capacity: number;
  occupied: number;
  remaining: number;
  full: boolean;
  cancelled: boolean;
  ended: boolean;
  inProgress: boolean;
  /** The shift starts more than three months from today in the event time zone. */
  tooEarly: boolean;
  volunteers: string[];
  event: {
    id: number;
    slug: string;
    title: string;
    description: string;
    location: string;
    timeZone: string;
  };
  when: {
    date: string;
    dateLabel: string;
    endDateLabel: string;
    sameDay: boolean;
    startLabel: string;
    endLabel: string;
    abbreviation: string;
    weekday: number;
    weekdayLabel: string;
  };
};

export type PublicEvent = {
  id: number;
  slug: string;
  title: string;
  description: string;
  location: string;
  timeZone: string;
  shifts: PublicShift[];
};

type ShiftRow = {
  id: number;
  role: string;
  starts_at_utc: string;
  ends_at_utc: string;
  capacity: number;
  cancelled: number;
  event_id: number;
  slug: string;
  title: string;
  description: string;
  location: string;
  tz: string;
  occupied: number;
};

const SHIFT_COLUMNS = `
  s.id AS id,
  s.role AS role,
  s.starts_at_utc AS starts_at_utc,
  s.ends_at_utc AS ends_at_utc,
  s.capacity AS capacity,
  s.cancelled AS cancelled,
  e.id AS event_id,
  e.slug AS slug,
  e.title AS title,
  e.description AS description,
  e.location AS location,
  e.tz AS tz,
  COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied
`;

const SHIFT_FROM = `
  FROM shifts s
  JOIN events e ON e.id = s.event_id
  LEFT JOIN signups su ON su.shift_id = s.id
`;

export function getPublishedEvent(db: Database.Database, slug: string, now: string): PublicEvent | null {
  const event = db
    .prepare(
      `SELECT id, slug, title, description, location, tz, published
       FROM events WHERE slug = ?`,
    )
    .get(slug) as
    | {
        id: number;
        slug: string;
        title: string;
        description: string;
        location: string;
        tz: string;
        published: number;
      }
    | undefined;
  if (!event || event.published !== 1) return null;
  // A shift that already ended stays through the rest of its local day, then leaves at midnight.
  const todayStart = localToUtc(todayInZone(event.tz, Temporal.Instant.from(now)), '00:00', event.tz);
  const rows = db
    .prepare(
      `SELECT ${SHIFT_COLUMNS}
       ${SHIFT_FROM}
       WHERE e.id = ? AND s.cancelled = 0 AND (s.ends_at_utc > ? OR s.starts_at_utc >= ?)
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.role, s.id`,
    )
    .all(event.id, now, todayStart) as ShiftRow[];
  const names = volunteerNamesByShift(db, rows.map((row) => row.id));
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    description: event.description,
    location: event.location,
    timeZone: event.tz,
    shifts: rows
      .map((row) => presentShift(row, now, names.get(row.id) ?? []))
      .filter((shift) => !shift.tooEarly),
  };
}

export function getPublicShift(db: Database.Database, id: number, now: string): PublicShift | null {
  const row = db
    .prepare(
      `SELECT ${SHIFT_COLUMNS}
       ${SHIFT_FROM}
       WHERE s.id = ? AND e.published = 1
       GROUP BY s.id`,
    )
    .get(id) as ShiftRow | undefined;
  if (!row) return null;
  const names = volunteerNamesByShift(db, [row.id]);
  return presentShift(row, now, names.get(row.id) ?? []);
}

export function spotsSentence(shift: Pick<PublicShift, 'occupied' | 'capacity'>): string {
  const filled = Math.min(shift.capacity, Math.max(0, shift.occupied));
  return `${filled}/${shift.capacity} spots filled`;
}

/** One roster line. A signup that holds several spots stays one name, with the count beside it. */
export function partyRosterLabel(name: string, groupSize: number): string {
  return groupSize > 1 ? `${name} (${groupSize} people)` : name;
}

function presentShift(row: ShiftRow, now: string, volunteers: string[]): PublicShift {
  const start = formatInstantInZone(row.starts_at_utc, row.tz);
  const end = formatInstantInZone(row.ends_at_utc, row.tz);
  const occupied = Number(row.occupied);
  const capacity = Number(row.capacity);
  const remaining = Math.max(0, capacity - occupied);
  const cancelled = row.cancelled === 1;
  const ended = row.ends_at_utc <= now;
  const inProgress = !cancelled && !ended && row.starts_at_utc <= now;
  const today = todayInZone(row.tz, Temporal.Instant.from(now));
  const tooEarly = !isWithinSignupWindow(start.date, today);
  return {
    id: row.id,
    role: row.role,
    startsAtUtc: row.starts_at_utc,
    endsAtUtc: row.ends_at_utc,
    capacity,
    occupied,
    remaining,
    full: !cancelled && !ended && remaining === 0,
    cancelled,
    ended,
    inProgress,
    tooEarly,
    volunteers,
    event: {
      id: row.event_id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      location: row.location,
      timeZone: row.tz,
    },
    when: {
      date: start.date,
      dateLabel: start.dateLabel,
      endDateLabel: end.dateLabel,
      sameDay: start.date === end.date,
      startLabel: start.timeLabel,
      endLabel: end.timeLabel,
      abbreviation: start.abbreviation,
      weekday: start.weekday,
      weekdayLabel: WEEKDAY_LABELS[start.weekday] ?? 'Day',
    },
  };
}

function volunteerNamesByShift(db: Database.Database, shiftIds: number[]): Map<number, string[]> {
  const names = new Map<number, string[]>();
  if (shiftIds.length === 0) return names;
  const marks = shiftIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT shift_id AS shift_id, name AS name, group_size AS group_size
       FROM signups
       WHERE status = 'confirmed' AND anonymized_at IS NULL AND name IS NOT NULL
         AND shift_id IN (${marks})
       ORDER BY name COLLATE NOCASE, id`,
    )
    .all(...shiftIds) as { shift_id: number; name: string; group_size: number }[];
  for (const row of rows) {
    const label = partyRosterLabel(row.name, Number(row.group_size));
    const listed = names.get(row.shift_id);
    if (listed) listed.push(label);
    else names.set(row.shift_id, [label]);
  }
  return names;
}
