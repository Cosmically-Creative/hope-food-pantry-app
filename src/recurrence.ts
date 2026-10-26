import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { writeAudit } from './auth/audit.js';
import { signupDeadline } from './signup-window.js';
import { LocalTimeError, localShiftToUtc, todayInZone } from './time.js';

export type ExpandResult = {
  created: number;
  templates: number;
  skipped: string[];
};

type TemplateRow = {
  id: number;
  event_id: number;
  role: string;
  weekday: number;
  start_local: string;
  end_local: string;
  capacity: number;
  starts_on: string;
  ends_on: string | null;
  revision: number;
  tz: string;
};

/**
 * Add missing shifts from active weekly templates. A date that already has a
 * row for that template is left alone, including a cancelled row, so generation
 * cannot recreate or overwrite it. A local time that does not exist, or that
 * happens twice, is skipped instead of moved.
 */
export function expandTemplates(
  db: Database.Database,
  now: string,
  options?: { eventId?: number; timeZone?: string; coordinatorId?: number | null },
): ExpandResult {
  const coordinatorId = options?.coordinatorId ?? null;
  const eventId = options?.eventId;
  const timeZone = options?.timeZone;
  const run = db.transaction((): ExpandResult => {
    const templates = listTemplates(db, eventId, timeZone);
    let created = 0;
    const skipped: string[] = [];
    for (const template of templates) {
      const outcome = expandOne(db, template, now, coordinatorId);
      created += outcome.created;
      skipped.push(...outcome.skipped);
    }
    return { created, templates: templates.length, skipped };
  });
  return run.immediate();
}

function listTemplates(db: Database.Database, eventId: number | undefined, timeZone: string | undefined): TemplateRow[] {
  const filters = ['t.active = 1'];
  const params: Array<number | string> = [];
  if (eventId !== undefined) {
    filters.push('t.event_id = ?');
    params.push(eventId);
  }
  if (timeZone !== undefined) {
    filters.push('e.tz = ?');
    params.push(timeZone);
  }
  const sql = `SELECT t.id AS id, t.event_id AS event_id, t.role AS role, t.weekday AS weekday,
                      t.start_local AS start_local, t.end_local AS end_local, t.capacity AS capacity,
                      t.starts_on AS starts_on, t.ends_on AS ends_on, t.revision AS revision, e.tz AS tz
               FROM shift_templates t
               JOIN events e ON e.id = t.event_id
               WHERE ${filters.join(' AND ')}
               ORDER BY t.id`;
  return db.prepare(sql).all(...params) as TemplateRow[];
}

function expandOne(
  db: Database.Database,
  template: TemplateRow,
  now: string,
  coordinatorId: number | null,
): { created: number; skipped: string[] } {
  let today: string;
  try {
    today = todayInZone(template.tz, Temporal.Instant.from(now));
  } catch (err) {
    if (err instanceof LocalTimeError) return { created: 0, skipped: [err.message] };
    throw err;
  }
  const windowEnd = signupDeadline(today);
  const dates = occurrenceDates(template, today, windowEnd);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO shifts (
       event_id, template_id, occurrence_date, template_revision, role,
       starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 1)`,
  );
  let created = 0;
  const skipped: string[] = [];
  for (const date of dates) {
    let times: { startsAtUtc: string; endsAtUtc: string };
    try {
      times = localShiftToUtc(date, template.start_local, template.end_local, template.tz);
    } catch (err) {
      if (err instanceof LocalTimeError) {
        skipped.push(err.message);
        continue;
      }
      throw err;
    }
    const saved = insert.run(
      template.event_id,
      template.id,
      date,
      template.revision,
      template.role,
      times.startsAtUtc,
      times.endsAtUtc,
      template.capacity,
    );
    if (saved.changes === 1) created += 1;
  }
  if (created > 0) {
    writeAudit(db, coordinatorId, 'template.expand', { templateId: template.id, created }, now);
  }
  return { created, skipped };
}

function occurrenceDates(template: TemplateRow, today: string, windowEnd: string): string[] {
  let start = today > template.starts_on ? today : template.starts_on;
  let end = windowEnd;
  if (template.ends_on && template.ends_on < end) end = template.ends_on;
  if (start > end) return [];
  let date = Temporal.PlainDate.from(start);
  const last = Temporal.PlainDate.from(end);
  const weekday = date.dayOfWeek % 7;
  date = date.add({ days: (template.weekday - weekday + 7) % 7 });
  const dates: string[] = [];
  while (Temporal.PlainDate.compare(date, last) <= 0) {
    dates.push(date.toString());
    date = date.add({ days: 7 });
  }
  return dates;
}
