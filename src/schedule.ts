import type Database from 'better-sqlite3';
import { formatInstantInZone } from './time.js';

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
  const rows = db
    .prepare(
      `SELECT ${SHIFT_COLUMNS}
       ${SHIFT_FROM}
       WHERE e.id = ? AND s.cancelled = 0 AND s.ends_at_utc > ?
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.role, s.id`,
    )
    .all(event.id, now) as ShiftRow[];
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    description: event.description,
    location: event.location,
    timeZone: event.tz,
    shifts: rows.map((row) => presentShift(row, now)),
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
  return row ? presentShift(row, now) : null;
}

export function spotsSentence(shift: Pick<PublicShift, 'occupied' | 'capacity'>): string {
  const filled = Math.min(shift.capacity, Math.max(0, shift.occupied));
  return `${filled}/${shift.capacity} spots filled`;
}

function presentShift(row: ShiftRow, now: string): PublicShift {
  const start = formatInstantInZone(row.starts_at_utc, row.tz);
  const end = formatInstantInZone(row.ends_at_utc, row.tz);
  const occupied = Number(row.occupied);
  const capacity = Number(row.capacity);
  const remaining = Math.max(0, capacity - occupied);
  const cancelled = row.cancelled === 1;
  const ended = row.ends_at_utc <= now;
  const inProgress = !cancelled && !ended && row.starts_at_utc <= now;
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
    },
  };
}
