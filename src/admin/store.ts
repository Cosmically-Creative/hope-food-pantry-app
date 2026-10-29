import { createHash, randomBytes } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import type { EventInput, ShiftInput, TemplateInput } from './forms.js';
import { writeAudit } from '../auth/audit.js';
import { cancelPendingConfirmations, cancelPendingReminders, queueCancellation, queueChanged, queueCoordinatorNotices } from '../mail/queue.js';
import type { MailShift } from '../mail/templates.js';
import type { MailIdentity } from '../mail/types.js';
import { confirmedPersonOnShift, confirmedPersonShiftIds, reserveSignup, type ReserveInput, type ReserveResult } from '../signup.js';
import { expandTemplates } from '../recurrence.js';
import { isWithinSignupWindow } from '../signup-window.js';
import { isUniqueConstraint } from '../sqlite-error.js';
import { addLocalDays, assertSameDayShift, assertValidTimeZone, formatInstantInZone, formatUtc, localShiftToUtc, LocalTimeError, todayInZone } from '../time.js';

const MANAGE_TOKEN_TTL_HOURS = 24 * 7;
const REPLACED_LINK = 'This link replaces the earlier one. The previous link no longer works.';
/** Today through this many days ahead. The event shift list uses the same window. */
export const DESK_WINDOW_DAYS = 14;

export type AdminEventSummary = {
  id: number;
  title: string;
  slug: string;
  published: boolean;
  shiftCount: number;
};

export type HomeShift = {
  id: number;
  eventId: number;
  eventTitle: string;
  role: string;
  date: string;
  timeLabel: string;
  capacity: number;
  occupied: number;
  full: boolean;
};

export type HomeEvent = AdminEventSummary & {
  nextShift: { date: string; timeLabel: string } | null;
};

export type AdminShiftSummary = {
  id: number;
  role: string;
  whenLabel: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
  occupied: number;
  cancelled: boolean;
  endsAtUtc: string;
  signupCount: number;
  weeklyActive: boolean;
};

export type AdminEvent = {
  id: number;
  title: string;
  slug: string;
  description: string;
  location: string;
  tz: string;
  published: boolean;
  shifts: AdminShiftSummary[];
  templates: AdminTemplate[];
};

export type AdminTemplate = {
  id: number;
  eventId: number;
  role: string;
  weekday: number;
  start: string;
  end: string;
  capacity: number;
  startsOn: string;
  endsOn: string | null;
  active: boolean;
  revision: number;
};

export type RosterPerson = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  groupSize: number;
  status: 'confirmed' | 'cancelled';
};

export type AdminShift = AdminShiftSummary & {
  eventId: number;
  eventTitle: string;
  location: string;
  tz: string;
  people: RosterPerson[];
};

export type SignupRemoval = {
  id: number;
  shiftId: number;
  name: string | null;
  status: 'confirmed' | 'cancelled';
};

export type ShiftRemoval = {
  id: number;
  eventId: number;
  role: string;
  whenLabel: string;
  cancelled: boolean;
  ended: boolean;
  signupCount: number;
  weeklyActive: boolean;
};

export type TemplateRemoval = {
  id: number;
  eventId: number;
  role: string;
  weekday: number;
  active: boolean;
  shiftCount: number;
};

export type EventRemoval = {
  id: number;
  title: string;
  published: boolean;
  shiftCount: number;
  templateCount: number;
  signupCount: number;
};

export type MoveTarget = {
  id: number;
  /** Local start date, YYYY-MM-DD. Menus group choices that share this date. */
  date: string;
  /** Local date heading, such as Tuesday, October 20, 2026. */
  dateLabel: string;
  label: string;
};

type SaveResult = { ok: true; id: number; mailed: number; skipped?: string[] } | { ok: false; error: string };
type CancelResult = { ok: true; already: boolean; mailed: number } | { ok: false; error: string };

export function listAdminEvents(db: Database.Database): AdminEventSummary[] {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.title AS title, e.slug AS slug, e.published AS published,
              (SELECT COUNT(*) FROM shifts s WHERE s.event_id = e.id) AS shift_count
       FROM events e
       ORDER BY e.title, e.id`,
    )
    .all() as Array<{ id: number; title: string; slug: string; published: number; shift_count: number }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    published: row.published === 1,
    shiftCount: Number(row.shift_count),
  }));
}

/** Open and full shifts in the next two weeks, plus the next open shift on each event. */
export function listHomeBoard(db: Database.Database, now: string, timeZone: string): { shifts: HomeShift[]; events: HomeEvent[] } {
  const today = todayInZone(timeZone, Temporal.Instant.from(now));
  const cutoff = addLocalDays(today, DESK_WINDOW_DAYS);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.starts_at_utc AS starts_at_utc, s.capacity AS capacity,
              e.id AS event_id, e.title AS title, e.tz AS tz,
              COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN signups su ON su.shift_id = s.id
       WHERE s.cancelled = 0 AND s.ends_at_utc > ?
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.id`,
    )
    .all(now) as Array<{
    id: number;
    role: string;
    starts_at_utc: string;
    capacity: number;
    event_id: number;
    title: string;
    tz: string;
    occupied: number;
  }>;
  const nextByEvent = new Map<number, { date: string; timeLabel: string }>();
  const shifts: HomeShift[] = [];
  for (const row of rows) {
    const local = formatInstantInZone(row.starts_at_utc, row.tz);
    if (!nextByEvent.has(row.event_id)) nextByEvent.set(row.event_id, { date: local.date, timeLabel: local.timeLabel });
    if (local.date < today || local.date > cutoff) continue;
    const capacity = Number(row.capacity);
    const occupied = Number(row.occupied);
    shifts.push({
      id: row.id,
      eventId: row.event_id,
      eventTitle: row.title,
      role: row.role,
      date: local.date,
      timeLabel: local.timeLabel,
      capacity,
      occupied,
      full: occupied >= capacity,
    });
  }
  return {
    shifts,
    events: listAdminEvents(db).map((event) => ({ ...event, nextShift: nextByEvent.get(event.id) ?? null })),
  };
}

export function getAdminEvent(db: Database.Database, id: number): AdminEvent | null {
  const event = db
    .prepare(
      `SELECT id, title, slug, description, location, tz, published
       FROM events WHERE id = ?`,
    )
    .get(id) as
    | { id: number; title: string; slug: string; description: string; location: string; tz: string; published: number }
    | undefined;
  if (!event) return null;
  const shifts = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc,
              s.capacity AS capacity, s.cancelled AS cancelled,
              COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied,
              (SELECT COUNT(*) FROM signups su_all WHERE su_all.shift_id = s.id) AS signup_count,
              (SELECT t.active FROM shift_templates t WHERE t.id = s.template_id) AS weekly_active
       FROM shifts s
       LEFT JOIN signups su ON su.shift_id = s.id
       WHERE s.event_id = ?
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.id`,
    )
    .all(id) as ShiftRow[];
  const templates = db
    .prepare(
      `SELECT id, event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision
       FROM shift_templates
       WHERE event_id = ?
       ORDER BY active DESC, weekday, id`,
    )
    .all(id) as TemplateRow[];
  return {
    id: event.id,
    title: event.title,
    slug: event.slug,
    description: event.description,
    location: event.location,
    tz: event.tz,
    published: event.published === 1,
    shifts: shifts.map((row) => presentShift(row, event.tz)),
    templates: templates.map(presentTemplate),
  };
}

export function getAdminTemplate(db: Database.Database, eventId: number, templateId: number): AdminTemplate | null {
  const row = db
    .prepare(
      `SELECT id, event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision
       FROM shift_templates
       WHERE id = ? AND event_id = ?`,
    )
    .get(templateId, eventId) as TemplateRow | undefined;
  return row ? presentTemplate(row) : null;
}

export function getAdminShift(db: Database.Database, id: number): AdminShift | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc,
              s.capacity AS capacity, s.cancelled AS cancelled, e.id AS event_id, e.title AS title,
              e.location AS location, e.tz AS tz,
              COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied,
              (SELECT COUNT(*) FROM signups su_all WHERE su_all.shift_id = s.id) AS signup_count,
              (SELECT t.active FROM shift_templates t WHERE t.id = s.template_id) AS weekly_active
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN signups su ON su.shift_id = s.id
       WHERE s.id = ?
       GROUP BY s.id`,
    )
    .get(id) as (ShiftRow & { event_id: number; title: string; location: string; tz: string }) | undefined;
  if (!row) return null;
  const people = db
    .prepare(
      `SELECT id, name, email, phone, notes, status, group_size
       FROM signups
       WHERE shift_id = ? AND anonymized_at IS NULL AND name IS NOT NULL AND email IS NOT NULL
       ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id`,
    )
    .all(id) as Array<{
    id: number;
    name: string;
    email: string;
    phone: string | null;
    notes: string | null;
    status: string;
    group_size: number;
  }>;
  return {
    ...presentShift(row, row.tz),
    eventId: row.event_id,
    eventTitle: row.title,
    location: row.location,
    tz: row.tz,
    people: people.flatMap((person) => {
      if (person.status !== 'confirmed' && person.status !== 'cancelled') return [];
      return [{
        id: person.id,
        name: person.name,
        email: person.email,
        phone: person.phone,
        notes: person.notes,
        groupSize: Number(person.group_size),
        status: person.status,
      }];
    }),
  };
}

export function createEvent(
  db: Database.Database,
  coordinatorId: number,
  input: EventInput,
  now: string,
): SaveResult {
  const zone = timeZone(input.tz);
  if (!zone.ok) return zone;
  try {
    return db.transaction(() => {
      const inserted = db
        .prepare(
          `INSERT INTO events (slug, title, description, location, tz, published, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.slug, input.title, input.description, input.location, zone.tz, input.published ? 1 : 0, now);
      const id = Number(inserted.lastInsertRowid);
      writeAudit(db, coordinatorId, 'event.create', { eventId: id, published: input.published ? 1 : 0 }, now);
      return { ok: true as const, id, mailed: 0 };
    }).immediate();
  } catch (err) {
    if (isUniqueConstraint(err)) return { ok: false, error: 'That public address is already used.' };
    throw err;
  }
}

export function updateEvent(
  db: Database.Database,
  coordinatorId: number,
  id: number,
  input: EventInput,
  now: string,
  mail: MailIdentity,
): SaveResult {
  const zone = timeZone(input.tz);
  if (!zone.ok) return zone;
  try {
    return db.transaction((): SaveResult => {
      const existing = db
        .prepare('SELECT id AS id, location AS location FROM events WHERE id = ?')
        .get(id) as { id: number; location: string } | undefined;
      if (!existing) return { ok: false, error: 'That event is not available.' };
      db.prepare(
        `UPDATE events
         SET slug = ?, title = ?, description = ?, location = ?, tz = ?, published = ?
         WHERE id = ?`,
      ).run(input.slug, input.title, input.description, input.location, zone.tz, input.published ? 1 : 0, id);
      let mailed = 0;
      if (existing.location !== input.location) {
        const shifts = db
          .prepare('SELECT id AS id FROM shifts WHERE event_id = ? AND cancelled = 0 AND ends_at_utc > ?')
          .all(id, now) as Array<{ id: number }>;
        for (const shift of shifts) mailed += bumpAndNotify(db, shift.id, now, mail);
      }
      writeAudit(db, coordinatorId, 'event.update', { eventId: id, published: input.published ? 1 : 0, mailed }, now);
      return { ok: true as const, id, mailed };
    }).immediate();
  } catch (err) {
    if (isUniqueConstraint(err)) return { ok: false, error: 'That public address is already used.' };
    throw err;
  }
}

export function createShift(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  input: ShiftInput,
  now: string,
): SaveResult {
  const event = db.prepare('SELECT tz AS tz FROM events WHERE id = ?').get(eventId) as { tz: string } | undefined;
  if (!event) return { ok: false, error: 'That event is not available.' };
  const times = shiftTimes(input, event.tz);
  if (!times.ok) return times;
  const inserted = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
         VALUES (?, ?, ?, ?, ?, '', 0)`,
      )
      .run(eventId, input.role, times.startsAtUtc, times.endsAtUtc, input.capacity);
    const id = Number(result.lastInsertRowid);
    writeAudit(db, coordinatorId, 'shift.create', { shiftId: id, eventId }, now);
    return id;
  }).immediate();
  return { ok: true, id: inserted, mailed: 0 };
}

export function createTemplate(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  input: TemplateInput,
  now: string,
): SaveResult {
  const checked = templateInput(input);
  if (!checked.ok) return checked;
  const event = db.prepare('SELECT id AS id FROM events WHERE id = ?').get(eventId) as { id: number } | undefined;
  if (!event) return { ok: false, error: 'That event is not available.' };
  const inserted = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO shift_templates
           (event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(eventId, input.role, input.weekday, input.start, input.end, input.capacity, input.startsOn, input.endsOn);
    const id = Number(result.lastInsertRowid);
    writeAudit(db, coordinatorId, 'template.create', { templateId: id, eventId }, now);
    const filled = expandTemplates(db, now, { eventId, templateId: id, coordinatorId });
    return { id, skipped: filled.skipped };
  }).immediate();
  return { ok: true, id: inserted.id, mailed: 0, skipped: inserted.skipped };
}

export function updateTemplate(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  templateId: number,
  input: TemplateInput,
  now: string,
  mail: MailIdentity,
): SaveResult {
  const checked = templateInput(input);
  if (!checked.ok) return checked;
  try {
    return db.transaction((): SaveResult => {
      const existing = db
        .prepare(
          `SELECT t.role AS role, t.weekday AS weekday, t.start_local AS start_local, t.end_local AS end_local,
                  t.capacity AS capacity, t.starts_on AS starts_on, t.ends_on AS ends_on, t.active AS active, e.tz AS tz
           FROM shift_templates t
           JOIN events e ON e.id = t.event_id
           WHERE t.id = ? AND t.event_id = ?`,
        )
        .get(templateId, eventId) as
        | {
            role: string;
            weekday: number;
            start_local: string;
            end_local: string;
            capacity: number;
            starts_on: string;
            ends_on: string | null;
            active: number;
            tz: string;
          }
        | undefined;
      if (!existing) return { ok: false as const, error: 'That weekly template is not available.' };
      if (existing.active !== 1) return { ok: false as const, error: 'This weekly template has ended.' };
      const same =
        existing.role === input.role &&
        existing.weekday === input.weekday &&
        existing.start_local === input.start &&
        existing.end_local === input.end &&
        Number(existing.capacity) === input.capacity &&
        existing.starts_on === input.startsOn &&
        existing.ends_on === input.endsOn;
      if (same) {
        const filled = expandTemplates(db, now, { eventId, templateId, coordinatorId });
        return { ok: true as const, id: templateId, mailed: 0, skipped: filled.skipped };
      }
      const tooSmall = capacityBelowSignups(db, templateId, input, now);
      if (tooSmall) return { ok: false as const, error: tooSmall };
      const saved = db
        .prepare(
          `UPDATE shift_templates
           SET role = ?, weekday = ?, start_local = ?, end_local = ?, capacity = ?,
               starts_on = ?, ends_on = ?, revision = revision + 1
           WHERE id = ? AND event_id = ? AND active = 1`,
        )
        .run(
          input.role,
          input.weekday,
          input.start,
          input.end,
          input.capacity,
          input.startsOn,
          input.endsOn,
          templateId,
          eventId,
        );
      if (saved.changes !== 1) return { ok: false as const, error: 'This weekly template has ended.' };
      const revision = db.prepare('SELECT revision AS revision FROM shift_templates WHERE id = ?').get(templateId) as {
        revision: number;
      };
      const synced = syncTemplateShifts(db, coordinatorId, templateId, input, Number(revision.revision), existing.tz, now, mail);
      const filled = expandTemplates(db, now, { eventId, templateId, coordinatorId });
      writeAudit(
        db,
        coordinatorId,
        'template.update',
        {
          templateId,
          eventId,
          revision: Number(revision.revision),
          updated: synced.updated,
          removed: synced.removed,
          cancelled: synced.cancelled,
          mailed: synced.mailed,
        },
        now,
      );
      return { ok: true as const, id: templateId, mailed: synced.mailed, skipped: [...synced.skipped, ...filled.skipped] };
    }).immediate();
  } catch (err) {
    if (err instanceof BatchRemovalError) return { ok: false, error: err.message };
    throw err;
  }
}

type TemplateShiftRow = {
  id: number;
  occurrence_date: string;
  role: string;
  starts_at_utc: string;
  ends_at_utc: string;
  capacity: number;
  cancelled: number;
  manually_modified: number;
};

/** Future shifts from this template follow the saved pattern. A shift edited on its own, a cancelled date, and a shift that already ended stay as they are. */
function syncTemplateShifts(
  db: Database.Database,
  coordinatorId: number,
  templateId: number,
  input: TemplateInput,
  revision: number,
  tz: string,
  now: string,
  mail: MailIdentity,
): { updated: number; removed: number; cancelled: number; mailed: number; skipped: string[] } {
  const shifts = db
    .prepare(
      `SELECT id AS id, occurrence_date AS occurrence_date, role AS role, starts_at_utc AS starts_at_utc,
              ends_at_utc AS ends_at_utc, capacity AS capacity, cancelled AS cancelled, manually_modified AS manually_modified
       FROM shifts
       WHERE template_id = ?
       ORDER BY occurrence_date`,
    )
    .all(templateId) as TemplateShiftRow[];
  let updated = 0;
  let removed = 0;
  let cancelled = 0;
  let mailed = 0;
  const skipped: string[] = [];
  for (const shift of shifts) {
    if (shift.ends_at_utc <= now || shift.cancelled === 1 || shift.manually_modified === 1) continue;
    if (!occurrenceStillMatches(shift.occurrence_date, input)) {
      const roster = shiftRoster(db, shift.id);
      if (roster.signups > 0) {
        const result = cancelOpenShift(db, coordinatorId, shift.id, now, mail);
        if (!result.ok) throw new BatchRemovalError(result.error);
        mailed += result.mailed;
        if (!result.already) cancelled += 1;
      } else {
        purgeShift(db, shift.id);
        removed += 1;
      }
      continue;
    }
    let times: { startsAtUtc: string; endsAtUtc: string };
    try {
      times = localShiftToUtc(shift.occurrence_date, input.start, input.end, tz);
    } catch (err) {
      if (err instanceof LocalTimeError) {
        skipped.push(err.message);
        continue;
      }
      throw err;
    }
    const material = shift.role !== input.role || shift.starts_at_utc !== times.startsAtUtc || shift.ends_at_utc !== times.endsAtUtc;
    const saved = db
      .prepare(
        `UPDATE shifts
         SET role = ?, starts_at_utc = ?, ends_at_utc = ?, capacity = ?, template_revision = ?
         WHERE id = ? AND cancelled = 0 AND manually_modified = 0 AND ends_at_utc > ?`,
      )
      .run(input.role, times.startsAtUtc, times.endsAtUtc, input.capacity, revision, shift.id, now);
    if (saved.changes !== 1) continue;
    updated += 1;
    if (material) mailed += bumpAndNotify(db, shift.id, now, mail, false);
  }
  return { updated, removed, cancelled, mailed, skipped };
}

function capacityBelowSignups(db: Database.Database, templateId: number, input: TemplateInput, now: string): string | null {
  const shifts = db
    .prepare(
      `SELECT id AS id, occurrence_date AS occurrence_date, ends_at_utc AS ends_at_utc,
              cancelled AS cancelled, manually_modified AS manually_modified
       FROM shifts
       WHERE template_id = ?`,
    )
    .all(templateId) as Array<Pick<TemplateShiftRow, 'id' | 'occurrence_date' | 'ends_at_utc' | 'cancelled' | 'manually_modified'>>;
  for (const shift of shifts) {
    if (shift.ends_at_utc <= now || shift.cancelled === 1 || shift.manually_modified === 1) continue;
    if (!occurrenceStillMatches(shift.occurrence_date, input)) continue;
    if (shiftRoster(db, shift.id).occupied > input.capacity) {
      return 'Capacity cannot be lower than the number of people signed up.';
    }
  }
  return null;
}

function occurrenceStillMatches(date: string, input: TemplateInput): boolean {
  const weekday = Temporal.PlainDate.from(date).dayOfWeek % 7;
  if (weekday !== input.weekday) return false;
  if (date < input.startsOn) return false;
  if (input.endsOn !== null && date > input.endsOn) return false;
  return true;
}

function shiftRoster(db: Database.Database, shiftId: number): { occupied: number; signups: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'confirmed' THEN group_size ELSE 0 END), 0) AS occupied,
              COUNT(*) AS signups
       FROM signups
       WHERE shift_id = ?`,
    )
    .get(shiftId) as { occupied: number; signups: number };
  return { occupied: Number(row.occupied), signups: Number(row.signups) };
}

export function endTemplate(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  templateId: number,
  now: string,
  mail: MailIdentity,
): CancelResult {
  try {
    return db.transaction((): CancelResult => {
      const existing = db
        .prepare('SELECT active AS active FROM shift_templates WHERE id = ? AND event_id = ?')
        .get(templateId, eventId) as { active: number } | undefined;
      if (!existing) return { ok: false as const, error: 'That weekly template is not available.' };
      if (existing.active !== 1) return { ok: true as const, already: true, mailed: 0 };
      const saved = db
        .prepare('UPDATE shift_templates SET active = 0 WHERE id = ? AND event_id = ? AND active = 1')
        .run(templateId, eventId);
      if (saved.changes !== 1) return { ok: true as const, already: true, mailed: 0 };
      const shifts = db
        .prepare('SELECT id AS id, ends_at_utc AS ends_at_utc, cancelled AS cancelled FROM shifts WHERE template_id = ?')
        .all(templateId) as { id: number; ends_at_utc: string; cancelled: number }[];
      let mailed = 0;
      let removed = 0;
      let cancelled = 0;
      for (const shift of shifts) {
        if (shift.ends_at_utc <= now) {
          purgeShift(db, shift.id);
          writeAudit(db, coordinatorId, 'shift.delete', { shiftId: shift.id, eventId, templateId }, now);
          removed += 1;
          continue;
        }
        if (shift.cancelled === 1) continue;
        const result = cancelOpenShift(db, coordinatorId, shift.id, now, mail);
        if (!result.ok) throw new BatchRemovalError(result.error);
        mailed += result.mailed;
        if (!result.already) cancelled += 1;
      }
      writeAudit(db, coordinatorId, 'template.end', { templateId, eventId, removed, cancelled, mailed }, now);
      return { ok: true as const, already: false, mailed };
    }).immediate();
  } catch (err) {
    if (err instanceof BatchRemovalError) return { ok: false, error: err.message };
    throw err;
  }
}

export function readSignupRemoval(db: Database.Database, signupId: number): SignupRemoval | null {
  const row = db
    .prepare('SELECT id, shift_id, name, status FROM signups WHERE id = ?')
    .get(signupId) as { id: number; shift_id: number; name: string | null; status: string } | undefined;
  if (!row || (row.status !== 'confirmed' && row.status !== 'cancelled')) return null;
  return { id: row.id, shiftId: row.shift_id, name: row.name, status: row.status };
}

export function deleteCancelledSignup(
  db: Database.Database,
  coordinatorId: number,
  signupId: number,
  now: string,
): { ok: true; shiftId: number } | { ok: false; error: string } {
  return db.transaction((): { ok: true; shiftId: number } | { ok: false; error: string } => {
    const row = readSignupRemoval(db, signupId);
    if (!row) return { ok: false, error: 'That signup is not available.' };
    if (row.status !== 'cancelled') return { ok: false, error: 'Cancel this signup before removing it.' };
    deleteSignupMail(db, signupId);
    const removed = db.prepare(`DELETE FROM signups WHERE id = ? AND status = 'cancelled'`).run(signupId);
    if (removed.changes !== 1) return { ok: false, error: 'That signup is not available.' };
    writeAudit(db, coordinatorId, 'signup.delete', { signupId, shiftId: row.shiftId }, now);
    return { ok: true, shiftId: row.shiftId };
  }).immediate();
}

const BATCH_LIMIT = 100;

export function deleteCancelledSignups(
  db: Database.Database,
  coordinatorId: number,
  shiftId: number,
  signupIds: number[],
  now: string,
): { ok: true; shiftId: number; count: number } | { ok: false; error: string } {
  const ids = [...new Set(signupIds)];
  if (ids.length === 0) return { ok: false, error: 'Choose someone to remove.' };
  if (ids.length > BATCH_LIMIT) return { ok: false, error: 'Choose fewer people to remove.' };
  try {
    return db
      .transaction((): { ok: true; shiftId: number; count: number } | { ok: false; error: string } => {
        const rows = ids.map((id) => readSignupRemoval(db, id));
        for (const row of rows) {
          if (!row || row.shiftId !== shiftId) return { ok: false, error: 'That signup is not available.' };
        }
        for (const row of rows) {
          if (!row || row.status !== 'cancelled') return { ok: false, error: 'Cancel this signup before removing it.' };
        }
        for (const row of rows) {
          if (!row) continue;
          deleteSignupMail(db, row.id);
          const removed = db.prepare(`DELETE FROM signups WHERE id = ? AND status = 'cancelled'`).run(row.id);
          if (removed.changes !== 1) throw new BatchRemovalError('That signup is not available.');
          writeAudit(db, coordinatorId, 'signup.delete', { signupId: row.id, shiftId: row.shiftId }, now);
        }
        return { ok: true, shiftId, count: rows.length };
      })
      .immediate();
  } catch (err) {
    if (err instanceof BatchRemovalError) return { ok: false, error: err.message };
    throw err;
  }
}

export function readShiftRemoval(db: Database.Database, shiftId: number, now: string): ShiftRemoval | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.event_id AS event_id, s.role AS role, s.starts_at_utc AS starts_at_utc,
              s.ends_at_utc AS ends_at_utc, s.cancelled AS cancelled, e.tz AS tz,
              (SELECT COUNT(*) FROM signups su WHERE su.shift_id = s.id) AS signup_count,
              CASE WHEN t.active = 1 THEN 1 ELSE 0 END AS weekly_active
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN shift_templates t ON t.id = s.template_id
       WHERE s.id = ?`,
    )
    .get(shiftId) as
    | {
        id: number;
        event_id: number;
        role: string;
        starts_at_utc: string;
        ends_at_utc: string;
        cancelled: number;
        tz: string;
        signup_count: number;
        weekly_active: number;
      }
    | undefined;
  if (!row) return null;
  const when = formatInstantInZone(row.starts_at_utc, row.tz);
  const end = formatInstantInZone(row.ends_at_utc, row.tz);
  return {
    id: row.id,
    eventId: row.event_id,
    role: row.role,
    whenLabel: `${when.dateLabel}, ${when.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
    cancelled: row.cancelled === 1,
    ended: row.ends_at_utc <= now,
    signupCount: Number(row.signup_count),
    weeklyActive: row.weekly_active === 1,
  };
}

export function deleteFinishedShift(
  db: Database.Database,
  coordinatorId: number,
  shiftId: number,
  now: string,
): { ok: true; eventId: number } | { ok: false; error: string } {
  return db.transaction((): { ok: true; eventId: number } | { ok: false; error: string } => {
    const row = readShiftRemoval(db, shiftId, now);
    if (!row) return { ok: false, error: 'That shift is not available.' };
    if (!row.cancelled && !row.ended) {
      return { ok: false, error: 'Cancel this shift, or wait until it has ended, before removing it.' };
    }
    if (row.signupCount > 0) return { ok: false, error: 'Remove everyone on this roster first.' };
    deleteShiftMail(db, shiftId);
    const removed = db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
    if (removed.changes !== 1) return { ok: false, error: 'That shift is not available.' };
    writeAudit(db, coordinatorId, 'shift.delete', { shiftId, eventId: row.eventId }, now);
    return { ok: true, eventId: row.eventId };
  }).immediate();
}

export function deleteFinishedShifts(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  shiftIds: number[],
  now: string,
): { ok: true; eventId: number; count: number } | { ok: false; error: string } {
  const ids = [...new Set(shiftIds)];
  if (ids.length === 0) return { ok: false, error: 'Choose a shift to remove.' };
  if (ids.length > BATCH_LIMIT) return { ok: false, error: 'Choose fewer shifts to remove.' };
  try {
    return db
      .transaction((): { ok: true; eventId: number; count: number } | { ok: false; error: string } => {
        const rows = ids.map((id) => readShiftRemoval(db, id, now));
        for (const row of rows) {
          if (!row || row.eventId !== eventId) return { ok: false, error: 'That shift is not available.' };
        }
        for (const row of rows) {
          if (row && row.signupCount > 0) return { ok: false, error: 'Remove everyone on this roster first.' };
        }
        for (const row of rows) {
          if (row && !row.cancelled && !row.ended) {
            return { ok: false, error: 'Cancel this shift, or wait until it has ended, before removing it.' };
          }
        }
        for (const row of rows) {
          if (!row) continue;
          deleteShiftMail(db, row.id);
          const removed = db.prepare('DELETE FROM shifts WHERE id = ?').run(row.id);
          if (removed.changes !== 1) throw new BatchRemovalError('That shift is not available.');
          writeAudit(db, coordinatorId, 'shift.delete', { shiftId: row.id, eventId: row.eventId }, now);
        }
        return { ok: true, eventId, count: rows.length };
      })
      .immediate();
  } catch (err) {
    if (err instanceof BatchRemovalError) return { ok: false, error: err.message };
    throw err;
  }
}

class BatchRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRemovalError';
  }
}

export function readTemplateRemoval(db: Database.Database, eventId: number, templateId: number): TemplateRemoval | null {
  const row = db
    .prepare(
      `SELECT t.id AS id, t.event_id AS event_id, t.role AS role, t.weekday AS weekday, t.active AS active,
              (SELECT COUNT(*) FROM shifts s WHERE s.template_id = t.id) AS shift_count
       FROM shift_templates t
       WHERE t.id = ? AND t.event_id = ?`,
    )
    .get(templateId, eventId) as
    | { id: number; event_id: number; role: string; weekday: number; active: number; shift_count: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    role: row.role,
    weekday: row.weekday,
    active: row.active === 1,
    shiftCount: Number(row.shift_count),
  };
}

export function readEventRemoval(db: Database.Database, eventId: number): EventRemoval | null {
  const row = db
    .prepare(
      `SELECT e.id AS id, e.title AS title, e.published AS published,
              (SELECT COUNT(*) FROM shifts s WHERE s.event_id = e.id) AS shift_count,
              (SELECT COUNT(*) FROM shift_templates t WHERE t.event_id = e.id) AS template_count,
              (SELECT COUNT(*) FROM signups su JOIN shifts s ON s.id = su.shift_id WHERE s.event_id = e.id) AS signup_count
       FROM events e
       WHERE e.id = ?`,
    )
    .get(eventId) as
    | { id: number; title: string; published: number; shift_count: number; template_count: number; signup_count: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    published: row.published === 1,
    shiftCount: Number(row.shift_count),
    templateCount: Number(row.template_count),
    signupCount: Number(row.signup_count),
  };
}

export function deleteEvent(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  now: string,
): { ok: true } | { ok: false; error: string } {
  try {
    return db.transaction((): { ok: true } | { ok: false; error: string } => {
      const row = readEventRemoval(db, eventId);
      if (!row) return { ok: false, error: 'That event is not available.' };
      const removedRecords = deleteEventRecords(db, eventId);
      const removed = db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
      if (removed.changes !== 1) throw new EventDeleteMissed();
      writeAudit(
        db,
        coordinatorId,
        'event.delete',
        {
          eventId,
          shifts: removedRecords.shifts,
          templates: removedRecords.templates,
          signups: removedRecords.signups,
        },
        now,
      );
      return { ok: true };
    }).immediate();
  } catch (err) {
    if (err instanceof EventDeleteMissed) return { ok: false, error: 'That event is not available.' };
    throw err;
  }
}

class EventDeleteMissed extends Error {
  constructor() {
    super('That event is not available.');
    this.name = 'EventDeleteMissed';
  }
}

function deleteEventRecords(
  db: Database.Database,
  eventId: number,
): { shifts: number; templates: number; signups: number } {
  db.prepare(
    `DELETE FROM reminders_sent
     WHERE signup_id IN (
             SELECT su.id FROM signups su
             JOIN shifts s ON s.id = su.shift_id
             WHERE s.event_id = ?
           )
        OR outbox_id IN (
             SELECT o.id FROM outbox o
             WHERE o.shift_id IN (SELECT id FROM shifts WHERE event_id = ?)
                OR o.signup_id IN (
                     SELECT su.id FROM signups su
                     JOIN shifts s ON s.id = su.shift_id
                     WHERE s.event_id = ?
                   )
           )`,
  ).run(eventId, eventId, eventId);
  db.prepare(
    `DELETE FROM outbox
     WHERE shift_id IN (SELECT id FROM shifts WHERE event_id = ?)
        OR signup_id IN (
             SELECT su.id FROM signups su
             JOIN shifts s ON s.id = su.shift_id
             WHERE s.event_id = ?
           )`,
  ).run(eventId, eventId);
  const signups = db
    .prepare('DELETE FROM signups WHERE shift_id IN (SELECT id FROM shifts WHERE event_id = ?)')
    .run(eventId);
  const shifts = db.prepare('DELETE FROM shifts WHERE event_id = ?').run(eventId);
  const templates = db.prepare('DELETE FROM shift_templates WHERE event_id = ?').run(eventId);
  return { shifts: shifts.changes, templates: templates.changes, signups: signups.changes };
}

export function deleteEndedTemplate(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  templateId: number,
  now: string,
): { ok: true; eventId: number } | { ok: false; error: string } {
  return db.transaction((): { ok: true; eventId: number } | { ok: false; error: string } => {
    const row = readTemplateRemoval(db, eventId, templateId);
    if (!row) return { ok: false, error: 'That weekly template is not available.' };
    if (row.active) return { ok: false, error: 'End this template before removing it.' };
    const detached = db
      .prepare(
        `UPDATE shifts
         SET template_id = NULL, occurrence_date = NULL, template_revision = NULL
         WHERE template_id = ?`,
      )
      .run(templateId);
    const removed = db.prepare('DELETE FROM shift_templates WHERE id = ? AND event_id = ? AND active = 0').run(templateId, eventId);
    if (removed.changes !== 1) return { ok: false, error: 'That weekly template is not available.' };
    writeAudit(db, coordinatorId, 'template.delete', { templateId, eventId, detached: detached.changes }, now);
    return { ok: true, eventId };
  }).immediate();
}

export function updateShift(
  db: Database.Database,
  coordinatorId: number,
  id: number,
  input: ShiftInput,
  now: string,
  mail: MailIdentity,
): SaveResult {
  const zone = db
    .prepare(
      `SELECT e.tz AS tz
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       WHERE s.id = ?`,
    )
    .get(id) as { tz: string } | undefined;
  if (!zone) return { ok: false, error: 'That shift is not available.' };
  const times = shiftTimes(input, zone.tz);
  if (!times.ok) return times;
  return db.transaction((): SaveResult => {
    const existing = db
      .prepare(
        `SELECT s.role AS role, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc, s.cancelled AS cancelled,
                COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied
         FROM shifts s
         LEFT JOIN signups su ON su.shift_id = s.id
         WHERE s.id = ?
         GROUP BY s.id`,
      )
      .get(id) as
      | { role: string; starts_at_utc: string; ends_at_utc: string; cancelled: number; occupied: number }
      | undefined;
    if (!existing) return { ok: false as const, error: 'That shift is not available.' };
    if (existing.cancelled === 1) return { ok: false as const, error: 'This shift is cancelled.' };
    if (input.capacity < Number(existing.occupied)) {
      return { ok: false as const, error: 'Capacity cannot be lower than the number of people signed up.' };
    }
    const material = existing.role !== input.role || existing.starts_at_utc !== times.startsAtUtc || existing.ends_at_utc !== times.endsAtUtc;
    const saved = db
      .prepare(
        `UPDATE shifts
         SET role = ?, starts_at_utc = ?, ends_at_utc = ?, capacity = ?, manually_modified = 1
         WHERE id = ? AND cancelled = 0`,
      )
      .run(input.role, times.startsAtUtc, times.endsAtUtc, input.capacity, id);
    if (saved.changes !== 1) return { ok: false as const, error: 'This shift is cancelled.' };
    const mailed = material ? bumpAndNotify(db, id, now, mail) : 0;
    const version = db.prepare('SELECT version AS version FROM shifts WHERE id = ?').get(id) as { version: number };
    writeAudit(db, coordinatorId, 'shift.update', { shiftId: id, version: version.version, mailed }, now);
    return { ok: true as const, id, mailed };
  }).immediate();
}

export function cancelShift(
  db: Database.Database,
  coordinatorId: number,
  id: number,
  now: string,
  mail: MailIdentity,
): CancelResult {
  return db.transaction((): CancelResult => cancelOpenShift(db, coordinatorId, id, now, mail)).immediate();
}

export function cancelShifts(
  db: Database.Database,
  coordinatorId: number,
  eventId: number,
  shiftIds: number[],
  now: string,
  mail: MailIdentity,
): { ok: true; eventId: number; count: number; mailed: number } | { ok: false; error: string } {
  const ids = [...new Set(shiftIds)];
  if (ids.length === 0) return { ok: false, error: 'Choose a shift to cancel.' };
  if (ids.length > BATCH_LIMIT) return { ok: false, error: 'Choose fewer shifts to cancel.' };
  try {
    return db
      .transaction((): { ok: true; eventId: number; count: number; mailed: number } | { ok: false; error: string } => {
        const rows = ids.map((id) => readCancelTarget(db, id));
        for (const row of rows) {
          if (!row || row.eventId !== eventId) return { ok: false, error: 'That shift is not available.' };
        }
        for (const row of rows) {
          if (row && !row.cancelled && row.endsAtUtc <= now) return { ok: false, error: 'That shift has ended.' };
        }
        let count = 0;
        let mailed = 0;
        for (const row of rows) {
          if (!row || row.cancelled) continue;
          const result = cancelOpenShift(db, coordinatorId, row.id, now, mail);
          if (!result.ok) throw new BatchRemovalError(result.error);
          if (!result.already) count += 1;
          mailed += result.mailed;
        }
        return { ok: true, eventId, count, mailed };
      })
      .immediate();
  } catch (err) {
    if (err instanceof BatchRemovalError) return { ok: false, error: err.message };
    throw err;
  }
}

function readCancelTarget(
  db: Database.Database,
  shiftId: number,
): { id: number; eventId: number; endsAtUtc: string; cancelled: boolean } | null {
  const row = db
    .prepare('SELECT id AS id, event_id AS event_id, ends_at_utc AS ends_at_utc, cancelled AS cancelled FROM shifts WHERE id = ?')
    .get(shiftId) as { id: number; event_id: number; ends_at_utc: string; cancelled: number } | undefined;
  if (!row) return null;
  return { id: row.id, eventId: row.event_id, endsAtUtc: row.ends_at_utc, cancelled: row.cancelled === 1 };
}

function cancelOpenShift(
  db: Database.Database,
  coordinatorId: number,
  id: number,
  now: string,
  mail: MailIdentity,
): CancelResult {
  const shift = db.prepare('SELECT id AS id, cancelled AS cancelled FROM shifts WHERE id = ?').get(id) as
    | { id: number; cancelled: number }
    | undefined;
  if (!shift) return { ok: false, error: 'That shift is not available.' };
  if (shift.cancelled === 1) return { ok: true, already: true, mailed: 0 };
  const marked = db
    .prepare('UPDATE shifts SET cancelled = 1, version = version + 1, manually_modified = 1 WHERE id = ? AND cancelled = 0')
    .run(id);
  if (marked.changes !== 1) return { ok: true, already: true, mailed: 0 };
  const mailed = cancelConfirmedOnShift(db, id, now, mail);
  writeAudit(db, coordinatorId, 'shift.cancel', { shiftId: id, mailed }, now);
  return { ok: true, already: false, mailed };
}

export function cancelSignupAsCoordinator(
  db: Database.Database,
  coordinatorId: number,
  signupId: number,
  now: string,
  mail: MailIdentity,
): CancelResult & { shiftId?: number } {
  return db.transaction((): CancelResult & { shiftId?: number } => {
    const row = loadPerson(db, signupId);
    if (!row) return { ok: false, error: 'That signup is not available.' };
    if (row.status === 'cancelled') return { ok: true, already: true, mailed: 0, shiftId: row.shift_id };
    const token = cancelConfirmedPerson(db, row, now, mail);
    if (!token) return { ok: true, already: true, mailed: 0, shiftId: row.shift_id };
    writeAudit(db, coordinatorId, 'signup.cancel', { signupId: row.id, shiftId: row.shift_id }, now);
    return { ok: true, already: false, mailed: 1, shiftId: row.shift_id };
  }).immediate();
}

export function findSignupShift(db: Database.Database, signupId: number): number | null {
  const row = db
    .prepare('SELECT shift_id AS shift_id FROM signups WHERE id = ? AND anonymized_at IS NULL')
    .get(signupId) as { shift_id: number } | undefined;
  return row ? row.shift_id : null;
}

/** "Tuesday, October 20, 2026" becomes "October 20, 2026". The weekday stays on the menu group. */
function dateWithoutWeekday(dateLabel: string): string {
  const comma = dateLabel.indexOf(', ');
  return comma === -1 ? dateLabel : dateLabel.slice(comma + 2);
}

/** Other open shifts in this event that still have a spot. Full, cancelled, and ended shifts are omitted. */
export function listMoveTargets(
  db: Database.Database,
  eventId: number,
  shiftId: number,
  now: string,
  options?: { publishedOnly?: boolean; excludePerson?: { email: string; name: string }; signupWindow?: boolean; spotsNeeded?: number },
): MoveTarget[] {
  const blocked = new Set<number>();
  if (options?.excludePerson) {
    for (const shiftId of confirmedPersonShiftIds(db, options.excludePerson.email, options.excludePerson.name)) {
      blocked.add(shiftId);
    }
  }
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc,
              s.capacity AS capacity, e.tz AS tz, e.published AS published,
              COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN signups su ON su.shift_id = s.id
       WHERE s.event_id = ? AND s.id != ? AND s.cancelled = 0 AND s.ends_at_utc > ?
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.id`,
    )
    .all(eventId, shiftId, now) as Array<{
    id: number;
    role: string;
    starts_at_utc: string;
    ends_at_utc: string;
    capacity: number;
    tz: string;
    published: number;
    occupied: number;
  }>;
  return rows.flatMap((row) => {
    if (options?.publishedOnly && row.published !== 1) return [];
    if (blocked.has(row.id)) return [];
    const needed = options?.spotsNeeded && options.spotsNeeded > 0 ? options.spotsNeeded : 1;
    if (Number(row.occupied) + needed > Number(row.capacity)) return [];
    const start = formatInstantInZone(row.starts_at_utc, row.tz);
    const end = formatInstantInZone(row.ends_at_utc, row.tz);
    if (options?.signupWindow && !isWithinSignupWindow(start.date, todayInZone(row.tz, Temporal.Instant.from(now)))) return [];
    return [{
      id: row.id,
      date: start.date,
      dateLabel: start.dateLabel,
      label: `${row.role}, ${dateWithoutWeekday(start.dateLabel)}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
    }];
  });
}

/** Open shifts a coordinator can add this person to. Full, cancelled, ended, and already-confirmed shifts are omitted. A shift that is not on the public list is still included. */
export function listOpenShiftsForPerson(
  db: Database.Database,
  person: { email: string; name: string },
  now: string,
): MoveTarget[] {
  const blocked = new Set(confirmedPersonShiftIds(db, person.email, person.name));
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc,
              s.capacity AS capacity, e.title AS title, e.tz AS tz, e.published AS published,
              COALESCE(SUM(CASE WHEN su.status = 'confirmed' THEN su.group_size ELSE 0 END), 0) AS occupied
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN signups su ON su.shift_id = s.id
       WHERE s.cancelled = 0 AND s.ends_at_utc > ?
       GROUP BY s.id
       ORDER BY s.starts_at_utc, s.id`,
    )
    .all(now) as Array<{
    id: number;
    role: string;
    starts_at_utc: string;
    ends_at_utc: string;
    capacity: number;
    title: string;
    tz: string;
    published: number;
    occupied: number;
  }>;
  return rows.flatMap((row) => {
    if (blocked.has(row.id)) return [];
    if (Number(row.occupied) >= Number(row.capacity)) return [];
    const start = formatInstantInZone(row.starts_at_utc, row.tz);
    const end = formatInstantInZone(row.ends_at_utc, row.tz);
    const publicity = row.published === 1 ? '' : ' (not on the public list)';
    return [{
      id: row.id,
      date: start.date,
      dateLabel: start.dateLabel,
      label: `${row.title}: ${row.role}, ${dateWithoutWeekday(start.dateLabel)}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}${publicity}`,
    }];
  });
}

export type MoveResult =
  | { ok: true; fromShiftId: number; toShiftId: number; newSignupId: number; replay: boolean; manageToken: string | null }
  | { ok: false; error: string; shiftId?: number };

/**
 * Moves one confirmed signup onto another open shift in the same event.
 * Every spot the signup holds moves with it. A failed move leaves the original signup confirmed.
 */
export function moveSignup(
  db: Database.Database,
  coordinatorId: number,
  signupId: number,
  destinationShiftId: number,
  operationId: string,
  now: string,
  mail: MailIdentity,
): MoveResult {
  return runTransfer(db, signupId, destinationShiftId, operationId, now, mail, {
    coordinatorId,
    action: 'signup.move',
    audience: 'coordinator',
    requirePublished: false,
  });
}

/** The volunteer switches from their private link. The new link is returned only for a new switch. */
export function switchSignup(
  db: Database.Database,
  signupId: number,
  destinationShiftId: number,
  operationId: string,
  now: string,
  mail: MailIdentity,
): MoveResult {
  return runTransfer(db, signupId, destinationShiftId, operationId, now, mail, {
    coordinatorId: null,
    action: 'signup.switch',
    audience: 'volunteer',
    requirePublished: true,
  });
}

function runTransfer(
  db: Database.Database,
  signupId: number,
  destinationShiftId: number,
  operationId: string,
  now: string,
  mail: MailIdentity,
  options: TransferOptions,
): MoveResult {
  const operationKey = sha256(operationId);
  try {
    return db.transaction((): MoveResult => relocate(db, signupId, destinationShiftId, operationKey, now, mail, options)).immediate();
  } catch (err) {
    if (!isUniqueConstraint(err)) throw err;
    const source = loadMoveSource(db, signupId);
    const existing = findMoveOperation(db, operationKey);
    if (
      source?.email_norm &&
      existing &&
      existing.shiftId === destinationShiftId &&
      existing.emailNorm === source.email_norm &&
      existing.status === 'confirmed'
    ) {
      return { ok: true, fromShiftId: source.shift_id, toShiftId: destinationShiftId, newSignupId: existing.id, replay: true, manageToken: null };
    }
    if (source?.name && source.email_norm && confirmedPersonOnShift(db, destinationShiftId, source.email_norm, source.name)) {
      return { ok: false, error: transferError(options.audience, 'duplicate'), shiftId: source.shift_id };
    }
    return { ok: false, error: transferError(options.audience, 'used'), shiftId: source?.shift_id };
  }
}

function relocate(
  db: Database.Database,
  signupId: number,
  destinationShiftId: number,
  operationKey: string,
  now: string,
  mail: MailIdentity,
  options: TransferOptions,
): MoveResult {
  const source = loadMoveSource(db, signupId);
  if (!source?.name || !source.email || !source.email_norm) return { ok: false, error: transferError(options.audience, 'unavailable') };
  const existing = findMoveOperation(db, operationKey);
  if (existing) {
    if (existing.shiftId === destinationShiftId && existing.emailNorm === source.email_norm && existing.status === 'confirmed') {
      return { ok: true, fromShiftId: source.shift_id, toShiftId: destinationShiftId, newSignupId: existing.id, replay: true, manageToken: null };
    }
    return { ok: false, error: transferError(options.audience, 'used'), shiftId: source.shift_id };
  }
  if (source.status !== 'confirmed') {
    return { ok: false, error: transferError(options.audience, 'cancelled'), shiftId: source.shift_id };
  }
  if (!Number.isSafeInteger(destinationShiftId) || destinationShiftId <= 0) {
    return { ok: false, error: transferError(options.audience, 'choose'), shiftId: source.shift_id };
  }
  if (destinationShiftId === source.shift_id) return { ok: false, error: transferError(options.audience, 'same'), shiftId: source.shift_id };
  const destination = db
    .prepare(
      `SELECT s.id AS id, s.event_id AS event_id, s.cancelled AS cancelled, s.starts_at_utc AS starts_at_utc,
              s.ends_at_utc AS ends_at_utc, s.capacity AS capacity, e.published AS published, e.tz AS tz
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       WHERE s.id = ?`,
    )
    .get(destinationShiftId) as
    | {
        id: number;
        event_id: number;
        cancelled: number;
        starts_at_utc: string;
        ends_at_utc: string;
        capacity: number;
        published: number;
        tz: string;
      }
    | undefined;
  if (!destination) return { ok: false, error: transferError(options.audience, 'missing'), shiftId: source.shift_id };
  if (destination.event_id !== source.event_id) return { ok: false, error: transferError(options.audience, 'event'), shiftId: source.shift_id };
  if (options.requirePublished && destination.published !== 1) {
    return { ok: false, error: transferError(options.audience, 'missing'), shiftId: source.shift_id };
  }
  if (destination.cancelled === 1 || destination.ends_at_utc <= now) {
    return { ok: false, error: transferError(options.audience, 'closed'), shiftId: source.shift_id };
  }
  if (options.audience === 'volunteer') {
    const start = formatInstantInZone(destination.starts_at_utc, destination.tz);
    const today = todayInZone(destination.tz, Temporal.Instant.from(now));
    if (!isWithinSignupWindow(start.date, today)) {
      return { ok: false, error: transferError(options.audience, 'early'), shiftId: source.shift_id };
    }
  }
  if (confirmedPersonOnShift(db, destination.id, source.email_norm, source.name)) {
    return { ok: false, error: transferError(options.audience, 'duplicate'), shiftId: source.shift_id };
  }
  const occupied = db
    .prepare(
      `SELECT COALESCE(SUM(group_size), 0) AS occupied
       FROM signups WHERE shift_id = ? AND status = 'confirmed'`,
    )
    .get(destination.id) as { occupied: number };
  const groupSize = Number(source.group_size);
  const taken = Number(occupied.occupied);
  if (taken + groupSize > destination.capacity) {
    const code = groupSize > 1 && taken < destination.capacity ? 'room' : 'full';
    return { ok: false, error: transferError(options.audience, code), shiftId: source.shift_id };
  }

  const retired = issueManageToken(destination.ends_at_utc);
  const cancelled = db
    .prepare(
      `UPDATE signups
       SET status = 'cancelled', manage_token_hash = ?, token_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'confirmed' AND anonymized_at IS NULL`,
    )
    .run(retired.hash, now, now, source.id);
  if (cancelled.changes !== 1) return { ok: false, error: transferError(options.audience, 'cancelled'), shiftId: source.shift_id };
  cancelPendingConfirmations(db, source.id);
  cancelPendingReminders(db, source.id);

  const issued = issueManageToken(destination.ends_at_utc);
  const inserted = db
    .prepare(
      `INSERT INTO signups (
         shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
         group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
         created_at, updated_at, operation_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      destination.id,
      source.name,
      source.email,
      source.email_norm,
      source.phone,
      source.is_minor,
      source.is_minor === 1 ? source.guardian_name : null,
      source.is_minor === 1 ? source.guardian_email : null,
      groupSize,
      source.notes,
      issued.hash,
      issued.expiresAt,
      source.reminders_off,
      now,
      now,
      operationKey,
    );
  const newSignupId = Number(inserted.lastInsertRowid);
  const shift = mailShift(db, destination.id);
  if (!shift) throw new Error('The destination shift was not available after it was checked.');
    queueChanged(
    db,
    {
      signupId: newSignupId,
      shiftId: destination.id,
      shiftVersion: shift.version,
      token: issued.token,
      volunteerName: source.name,
      volunteerEmail: source.email_norm,
      groupSize,
      shift: shift.facts,
      mail,
      now,
    },
    options.audience === 'volunteer' ? 'switch' : 'move',
  );
  const previous = mailShift(db, source.shift_id);
  queueCoordinatorNotices(db, {
    action: options.audience === 'volunteer' ? 'switch' : 'move',
    signupId: newSignupId,
    shiftId: destination.id,
    shiftVersion: shift.version,
    volunteerName: source.name,
    volunteerEmail: source.email_norm,
    groupSize,
    shift: shift.facts,
    fromShift: previous?.facts,
    mail,
    now,
  });
  writeAudit(db, options.coordinatorId, options.action, {
    signupId: source.id,
    fromShiftId: source.shift_id,
    toShiftId: destination.id,
    newSignupId,
  }, now);
  return { ok: true, fromShiftId: source.shift_id, toShiftId: destination.id, newSignupId, replay: false, manageToken: issued.token };
}

type TransferOptions = {
  coordinatorId: number | null;
  action: 'signup.move' | 'signup.switch';
  audience: 'coordinator' | 'volunteer';
  requirePublished: boolean;
};

function transferError(audience: TransferOptions['audience'], code: TransferError): string {
  const coordinator: Record<TransferError, string> = {
    unavailable: 'That signup is not available.',
    cancelled: 'That signup is cancelled.',
    choose: 'Choose a shift.',
    same: 'They are already on this shift.',
    missing: 'That shift is not available.',
    event: 'Choose a shift in this event.',
    closed: 'That shift is closed.',
    early: 'That shift is not open for sign-up yet.',
    duplicate: 'That person is already signed up for this shift.',
    full: 'That shift is full.',
    room: 'That shift does not have room for everyone on this signup.',
    used: 'This form was already used for a different signup. Submit it again.',
    foreign: 'That signup is not on this page.',
    already: 'That signup is already cancelled.',
  };
  const volunteer: Record<TransferError, string> = {
    unavailable: 'That signup is not available.',
    cancelled: 'This signup is cancelled.',
    choose: 'Choose a shift.',
    same: 'You are already on this shift.',
    missing: 'That shift is not available.',
    event: 'Choose a shift in this event.',
    closed: 'That shift is closed.',
    early: 'Sign-up for that shift opens three months before the date.',
    duplicate: 'You are already signed up for that shift.',
    full: 'That shift is full.',
    room: 'That shift does not have room for everyone on this signup.',
    used: 'This form was already used. Open the link from your email.',
    foreign: 'That signup is not on this page.',
    already: 'That signup is already cancelled.',
  };
  return (audience === 'volunteer' ? volunteer : coordinator)[code];
}

type TransferError =
  | 'unavailable'
  | 'cancelled'
  | 'choose'
  | 'same'
  | 'missing'
  | 'event'
  | 'closed'
  | 'early'
  | 'duplicate'
  | 'full'
  | 'room'
  | 'used'
  | 'foreign'
  | 'already';

function loadMoveSource(db: Database.Database, signupId: number): MoveSource | null {
  const row = db
    .prepare(
      `SELECT su.id AS id, su.shift_id AS shift_id, s.event_id AS event_id, su.name AS name, su.email AS email,
              su.email_norm AS email_norm, su.phone AS phone, su.notes AS notes, su.is_minor AS is_minor,
              su.guardian_name AS guardian_name, su.guardian_email AS guardian_email, su.reminders_off AS reminders_off,
              su.group_size AS group_size, su.status AS status
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       WHERE su.id = ? AND su.anonymized_at IS NULL`,
    )
    .get(signupId) as MoveSource | undefined;
  if (!row || !row.name || !row.email || !row.email_norm) return null;
  return row;
}

function findMoveOperation(
  db: Database.Database,
  operationKey: string,
): { id: number; shiftId: number; emailNorm: string; status: string } | null {
  const row = db
    .prepare(
      `SELECT id AS id, shift_id AS shiftId, email_norm AS emailNorm, status AS status
       FROM signups
       WHERE operation_key = ? AND email_norm IS NOT NULL`,
    )
    .get(operationKey) as { id: number; shiftId: number; emailNorm: string; status: string } | undefined;
  return row ?? null;
}

/** One named signup. groupSize reserves that many spots, with the same rules as public signup. */
export function addWalkIn(
  db: Database.Database,
  coordinatorId: number,
  input: Omit<ReserveInput, 'audience' | 'onReserved'>,
): ReserveResult {
  return reserveSignup(db, {
    ...input,
    audience: 'coordinator',
    onReserved(signupId) {
      writeAudit(db, coordinatorId, 'signup.walkin', { signupId, shiftId: input.shiftId }, input.now);
    },
  });
}

function bumpAndNotify(db: Database.Database, shiftId: number, now: string, mail: MailIdentity, manual = true): number {
  const bumped = db
    .prepare(
      manual
        ? 'UPDATE shifts SET version = version + 1, manually_modified = 1 WHERE id = ? AND cancelled = 0'
        : 'UPDATE shifts SET version = version + 1 WHERE id = ? AND cancelled = 0 AND manually_modified = 0',
    )
    .run(shiftId);
  if (bumped.changes !== 1) return 0;
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE shift_id = ? AND status = 'pending' AND kind IN ('confirmation', 'changed')`,
  ).run('The shift changed before this message was sent.', shiftId);
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE shift_id = ? AND status = 'pending' AND kind = 'reminder'`,
  ).run('The shift changed before this reminder was sent.', shiftId);
  const shift = mailShift(db, shiftId);
  if (!shift) return 0;
  const people = db
    .prepare(
      `SELECT id, name, email_norm, shift_id, status, group_size
       FROM signups
       WHERE shift_id = ? AND status = 'confirmed' AND anonymized_at IS NULL AND name IS NOT NULL AND email_norm IS NOT NULL`,
    )
    .all(shiftId) as PersonRow[];
  let mailed = 0;
  for (const person of people) {
    const token = replaceManageToken(db, person.id, shift.endsAtUtc, now);
    if (!token || !person.name || !person.email_norm) continue;
    queueChanged(db, {
      signupId: person.id,
      shiftId: person.shift_id,
      shiftVersion: shift.version,
      token,
      volunteerName: person.name,
      volunteerEmail: person.email_norm,
      groupSize: Number(person.group_size),
      shift: shift.facts,
      mail,
      now,
    });
    queueCoordinatorNotices(db, {
      action: 'change',
      signupId: person.id,
      shiftId: person.shift_id,
      shiftVersion: shift.version,
      volunteerName: person.name,
      volunteerEmail: person.email_norm,
      groupSize: Number(person.group_size),
      shift: shift.facts,
      mail,
      now,
    });
    mailed += 1;
  }
  return mailed;
}

function cancelConfirmedOnShift(db: Database.Database, shiftId: number, now: string, mail: MailIdentity): number {
  const people = db
    .prepare(
      `SELECT id, name, email_norm, shift_id, status, group_size
       FROM signups
       WHERE shift_id = ? AND status = 'confirmed' AND anonymized_at IS NULL AND name IS NOT NULL AND email_norm IS NOT NULL`,
    )
    .all(shiftId) as PersonRow[];
  let mailed = 0;
  for (const person of people) {
    if (cancelConfirmedPerson(db, person, now, mail)) mailed += 1;
  }
  return mailed;
}

function cancelConfirmedPerson(db: Database.Database, person: PersonRow, now: string, mail: MailIdentity): string | null {
  const shift = mailShift(db, person.shift_id);
  if (!shift || !person.name || !person.email_norm) return null;
  const issued = issueManageToken(shift.endsAtUtc);
  const updated = db
    .prepare(
      `UPDATE signups
       SET status = 'cancelled', manage_token_hash = ?, token_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'confirmed' AND anonymized_at IS NULL`,
    )
    .run(issued.hash, issued.expiresAt, now, person.id);
  if (updated.changes !== 1) return null;
  cancelPendingConfirmations(db, person.id);
  cancelPendingReminders(db, person.id, 'The signup was cancelled before this reminder was sent.');
  queueCancellation(db, {
    signupId: person.id,
    shiftId: person.shift_id,
    shiftVersion: shift.version,
    token: issued.token,
    volunteerName: person.name,
    volunteerEmail: person.email_norm,
    groupSize: Number(person.group_size),
    shift: shift.facts,
    mail,
    now,
    linkNote: REPLACED_LINK,
  });
  queueCoordinatorNotices(db, {
    action: 'cancel',
    signupId: person.id,
    shiftId: person.shift_id,
    shiftVersion: shift.version,
    volunteerName: person.name,
    volunteerEmail: person.email_norm,
    groupSize: Number(person.group_size),
    shift: shift.facts,
    mail,
    now,
  });
  return issued.token;
}

function replaceManageToken(db: Database.Database, signupId: number, endsAtUtc: string, now: string): string | null {
  const issued = issueManageToken(endsAtUtc);
  const updated = db
    .prepare(
      `UPDATE signups
       SET manage_token_hash = ?, token_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'confirmed' AND anonymized_at IS NULL`,
    )
    .run(issued.hash, issued.expiresAt, now, signupId);
  return updated.changes === 1 ? issued.token : null;
}

function issueManageToken(endsAtUtc: string): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = formatUtc(Temporal.Instant.from(endsAtUtc).add({ hours: MANAGE_TOKEN_TTL_HOURS }));
  return { token, hash: sha256(token), expiresAt };
}

function mailShift(db: Database.Database, shiftId: number): { version: number; endsAtUtc: string; facts: MailShift } | null {
  const shift = db
    .prepare(
      `SELECT s.role AS role, s.version AS version, s.starts_at_utc AS starts_at_utc, s.ends_at_utc AS ends_at_utc,
              e.title AS title, e.location AS location, e.tz AS tz
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       WHERE s.id = ?`,
    )
    .get(shiftId) as
    | {
        role: string;
        version: number;
        starts_at_utc: string;
        ends_at_utc: string;
        title: string;
        location: string;
        tz: string;
      }
    | undefined;
  if (!shift) return null;
  const start = formatInstantInZone(shift.starts_at_utc, shift.tz);
  const end = formatInstantInZone(shift.ends_at_utc, shift.tz);
  return {
    version: shift.version,
    endsAtUtc: shift.ends_at_utc,
    facts: {
      role: shift.role,
      eventTitle: shift.title,
      location: shift.location,
      whenLabel: `${start.dateLabel}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
    },
  };
}

function loadPerson(db: Database.Database, signupId: number): PersonRow | null {
  const row = db
    .prepare(
      `SELECT id, name, email_norm, shift_id, status, group_size
       FROM signups
       WHERE id = ? AND anonymized_at IS NULL`,
    )
    .get(signupId) as PersonRow | undefined;
  return row ?? null;
}

function presentShift(row: ShiftRow, tz: string): AdminShiftSummary {
  const start = formatInstantInZone(row.starts_at_utc, tz);
  const end = formatInstantInZone(row.ends_at_utc, tz);
  return {
    id: row.id,
    role: row.role,
    whenLabel: `${start.dateLabel}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
    date: start.date,
    start: start.time24,
    end: end.time24,
    capacity: Number(row.capacity),
    occupied: Number(row.occupied),
    cancelled: row.cancelled === 1,
    endsAtUtc: row.ends_at_utc,
    signupCount: Number(row.signup_count),
    weeklyActive: Number(row.weekly_active) === 1,
  };
}

function deleteSignupMail(db: Database.Database, signupId: number): void {
  db.prepare(
    `DELETE FROM reminders_sent
     WHERE signup_id = ?
        OR outbox_id IN (SELECT id FROM outbox WHERE signup_id = ?)`,
  ).run(signupId, signupId);
  db.prepare('DELETE FROM outbox WHERE signup_id = ?').run(signupId);
}

function deleteShiftMail(db: Database.Database, shiftId: number): void {
  db.prepare(
    `DELETE FROM reminders_sent
     WHERE outbox_id IN (SELECT id FROM outbox WHERE shift_id = ?)
        OR signup_id IN (SELECT id FROM signups WHERE shift_id = ?)`,
  ).run(shiftId, shiftId);
  db.prepare('DELETE FROM outbox WHERE shift_id = ?').run(shiftId);
}

/** Deletes an ended template shift and the roster on it. Pending mail for that shift is dropped. */
function purgeShift(db: Database.Database, shiftId: number): void {
  deleteShiftMail(db, shiftId);
  db.prepare(
    `DELETE FROM reminders_sent
     WHERE signup_id IN (SELECT id FROM signups WHERE shift_id = ?)
        OR outbox_id IN (SELECT id FROM outbox WHERE signup_id IN (SELECT id FROM signups WHERE shift_id = ?))`,
  ).run(shiftId, shiftId);
  db.prepare('DELETE FROM outbox WHERE signup_id IN (SELECT id FROM signups WHERE shift_id = ?)').run(shiftId);
  db.prepare('DELETE FROM signups WHERE shift_id = ?').run(shiftId);
  const removed = db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
  if (removed.changes !== 1) throw new BatchRemovalError('That shift is not available.');
}

function timeZone(tz: string): { ok: true; tz: string } | { ok: false; error: string } {
  try {
    return { ok: true, tz: assertValidTimeZone(tz) };
  } catch (err) {
    if (err instanceof LocalTimeError) return { ok: false, error: err.message };
    throw err;
  }
}

function templateInput(input: TemplateInput): { ok: true } | { ok: false; error: string } {
  if (input.role.trim().length === 0 || input.role.length > 80) return { ok: false, error: 'Enter a role.' };
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) return { ok: false, error: 'Choose a day.' };
  try {
    assertSameDayShift(input.start, input.end);
  } catch (err) {
    if (err instanceof LocalTimeError) return { ok: false, error: err.message };
    throw err;
  }
  if (!plainDate(input.startsOn)) return { ok: false, error: 'Enter the first date.' };
  if (input.endsOn !== null && !plainDate(input.endsOn)) return { ok: false, error: 'Enter an end date, or leave it blank.' };
  if (input.endsOn !== null && input.endsOn < input.startsOn) {
    return { ok: false, error: 'The end date must be on or after the first date.' };
  }
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > 500) {
    return { ok: false, error: 'Enter a capacity of at least 1.' };
  }
  return { ok: true };
}

function plainDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

function presentTemplate(row: TemplateRow): AdminTemplate {
  return {
    id: row.id,
    eventId: row.event_id,
    role: row.role,
    weekday: row.weekday,
    start: row.start_local,
    end: row.end_local,
    capacity: Number(row.capacity),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    active: row.active === 1,
    revision: Number(row.revision),
  };
}

function shiftTimes(
  input: ShiftInput,
  tz: string,
): { ok: true; startsAtUtc: string; endsAtUtc: string } | { ok: false; error: string } {
  try {
    return { ok: true, ...localShiftToUtc(input.date, input.start, input.end, tz) };
  } catch (err) {
    if (err instanceof LocalTimeError) return { ok: false, error: err.message };
    throw err;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  active: number;
  revision: number;
};

type ShiftRow = {
  id: number;
  role: string;
  starts_at_utc: string;
  ends_at_utc: string;
  capacity: number;
  cancelled: number;
  occupied: number;
  signup_count: number;
  weekly_active: number | null;
};

type PersonRow = {
  id: number;
  name: string | null;
  email_norm: string | null;
  shift_id: number;
  status: string;
  group_size: number;
};

type MoveSource = {
  id: number;
  shift_id: number;
  event_id: number;
  name: string | null;
  email: string | null;
  email_norm: string | null;
  phone: string | null;
  notes: string | null;
  is_minor: number;
  guardian_name: string | null;
  guardian_email: string | null;
  reminders_off: number;
  group_size: number;
  status: string;
};
