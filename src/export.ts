import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { formatInstantInZone } from './time.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 366;
const FORMULA = /^[\s\u0000-\u001F\u007F]*[=+\-@]/;

const COLUMNS = [
  'Date',
  'Start',
  'End',
  'Time zone',
  'Role',
  'Name',
  'Email',
  'Phone',
  'Group size',
  'Minor',
  'Guardian name',
  'Guardian email',
  'Notes',
  'Status',
  'Attended',
] as const;

export type RosterExport = { csv: string; rows: number };

type RosterRecord = {
  starts_at_utc: string;
  ends_at_utc: string;
  tz: string;
  role: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  group_size: number;
  is_minor: number;
  guardian_name: string | null;
  guardian_email: string | null;
  notes: string | null;
  status: string;
  attended: number | null;
  anonymized_at: string | null;
};

const ROSTER_SQL = `SELECT s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc, e.tz AS tz, s.role AS role,
            su.name AS name, su.email AS email, su.phone AS phone, su.group_size AS group_size,
            su.is_minor AS is_minor, su.guardian_name AS guardian_name, su.guardian_email AS guardian_email,
            su.notes AS notes, su.status AS status, su.attended AS attended, su.anonymized_at AS anonymized_at
     FROM signups su
     JOIN shifts s ON s.id = su.shift_id
     JOIN events e ON e.id = s.event_id`;

/** A spreadsheet cell that would otherwise be a formula is prefixed so it stays text. */
export function csvCell(value: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

/** Drops the quote prefix csvCell adds, then trims. A name that merely starts with an apostrophe stays. */
export function csvImportedCell(value: string): string {
  let text = value.normalize('NFC');
  if (text.startsWith("'") && FORMULA.test(text.slice(1))) text = text.slice(1);
  return text.trim();
}

export function exportShiftRoster(db: Database.Database, shiftId: number): RosterExport | null {
  const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return null;
  const rows = db
    .prepare(`${ROSTER_SQL} WHERE s.id = ? ORDER BY su.id`)
    .all(shiftId) as RosterRecord[];
  return renderRoster(rows);
}

export function exportEventRoster(db: Database.Database, eventId: number): RosterExport | null {
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!event) return null;
  const rows = db
    .prepare(`${ROSTER_SQL} WHERE e.id = ? ORDER BY s.starts_at_utc, s.id, su.id`)
    .all(eventId) as RosterRecord[];
  return renderRoster(rows);
}

export function exportDateRange(
  db: Database.Database,
  from: string,
  to: string,
): { ok: true; export: RosterExport } | { ok: false; error: string } {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return { ok: false, error: 'Use real dates.' };
  if (Temporal.PlainDate.compare(end, start) < 0) return { ok: false, error: 'The end date is before the start date.' };
  if (start.until(end, { largestUnit: 'days' }).days > MAX_RANGE_DAYS) {
    return { ok: false, error: 'Choose a range of one year or less.' };
  }
  const lower = `${start.subtract({ days: 2 }).toString()}T00:00:00.000Z`;
  const upper = `${end.add({ days: 2 }).toString()}T23:59:59.999Z`;
  const rows = db
    .prepare(
      `${ROSTER_SQL}
       WHERE s.starts_at_utc >= ? AND s.starts_at_utc <= ?
       ORDER BY s.starts_at_utc, s.id, su.id`,
    )
    .all(lower, upper) as RosterRecord[];
  const kept = rows.filter((row) => {
    const local = formatInstantInZone(row.starts_at_utc, row.tz).date;
    return local >= start.toString() && local <= end.toString();
  });
  return { ok: true, export: renderRoster(kept) };
}

export function dateStamp(value: string): number | null {
  const date = parseDate(value);
  if (!date) return null;
  return date.year * 10000 + date.month * 100 + date.day;
}

function renderRoster(rows: RosterRecord[]): RosterExport {
  const lines = [COLUMNS.map(csvCell).join(','), ...rows.map((row) => present(row).map(csvCell).join(','))];
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows: rows.length };
}

function present(row: RosterRecord): string[] {
  const start = formatInstantInZone(row.starts_at_utc, row.tz);
  const end = formatInstantInZone(row.ends_at_utc, row.tz);
  return [
    start.date,
    start.timeLabel,
    end.timeLabel,
    `${row.tz} (${start.abbreviation})`,
    row.role,
    row.name ?? '',
    row.email ?? '',
    row.phone ?? '',
    String(row.group_size),
    row.anonymized_at ? '' : row.is_minor === 1 ? 'Yes' : 'No',
    row.guardian_name ?? '',
    row.guardian_email ?? '',
    row.notes ?? '',
    row.status === 'cancelled' ? 'Cancelled' : 'Confirmed',
    row.attended === 1 ? 'Attended' : row.attended === 0 ? 'No-show' : '',
  ];
}

function parseDate(value: string): Temporal.PlainDate | null {
  if (!DATE.test(value)) return null;
  try {
    const date = Temporal.PlainDate.from(value);
    return date.toString() === value ? date : null;
  } catch {
    return null;
  }
}
