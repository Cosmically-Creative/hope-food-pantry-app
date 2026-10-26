import { createHash, randomBytes } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { rememberSignupContact } from './contacts.js';
import { normalizeEmail } from './email.js';
import { queueCancellation, queueConfirmation, cancelPendingConfirmations, cancelPendingReminders } from './mail/queue.js';
import type { MailIdentity } from './mail/types.js';
import { formatInstantInZone, formatUtc, type ZonedClock } from './time.js';

const MANAGE_TOKEN_TTL_HOURS = 24 * 7;

export type ReserveInput = {
  shiftId: number;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  operationId: string;
  now: string;
  mail: MailIdentity;
  /** Public signup stays on published shifts. A coordinator can record a walk-in before the event is public. */
  audience?: 'public' | 'coordinator';
  onReserved?: (signupId: number) => void;
};

export type ReserveResult =
  | { ok: true; signupId: number; manageToken: string | null; replay: boolean }
  | { ok: false; reason: 'not_found' | 'closed' | 'full' | 'duplicate' | 'conflict' };

export type ManageView = {
  signupId: number;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  status: 'confirmed' | 'cancelled';
  remindersOff: boolean;
  emailNorm: string;
  shiftId: number;
  eventId: number;
  role: string;
  location: string;
  eventTitle: string;
  when: ZonedClock;
};

/**
 * Takes one spot only when the published shift still has room.
 * The immediate transaction is the capacity lock and also queues confirmation mail.
 * A later send failure does not undo the reservation.
 */
export function reserveSignup(db: Database.Database, input: ReserveInput): ReserveResult {
  const emailNorm = normalizeEmail(input.email);
  const operationKey = sha256(input.operationId);
  const attempt = db.transaction(() => placeReservation(db, input, emailNorm, operationKey));
  try {
    return attempt.immediate();
  } catch (err) {
    if (!isUniqueConstraint(err)) throw err;
    const existing = findOperation(db, operationKey);
    if (existing && existing.shiftId === input.shiftId && existing.emailNorm === emailNorm) {
      return { ok: true, signupId: existing.id, manageToken: null, replay: true };
    }
    if (confirmedPersonOnShift(db, input.shiftId, emailNorm, input.name)) return { ok: false, reason: 'duplicate' };
    return { ok: false, reason: 'conflict' };
  }
}

export function findSignupByOperation(
  db: Database.Database,
  operationId: string,
): { id: number; shiftId: number; emailNorm: string } | null {
  return findOperation(db, sha256(operationId));
}

export function confirmedOperationShift(db: Database.Database, operationId: string): number | null {
  const found = findOperation(db, sha256(operationId));
  if (!found) return null;
  const row = db.prepare('SELECT status AS status FROM signups WHERE id = ?').get(found.id) as { status: string } | undefined;
  return row?.status === 'confirmed' ? found.shiftId : null;
}

export type CancelResult = { ok: true; already: boolean } | { ok: false; reason: 'invalid' };

/**
 * Marks this signup cancelled, frees its spot, and queues cancellation mail.
 * Cancelling the same link again is the same result and does not queue a second letter.
 * A pending confirmation is cancelled in this transaction. Mail already accepted cannot be recalled.
 */
export function cancelSignup(db: Database.Database, token: string, now: string, mail: MailIdentity): CancelResult {
  if (!manageTokenShape(token)) return { ok: false, reason: 'invalid' };
  const hash = sha256(token);
  return db.transaction(() => cancelConfirmed(db, hash, token, now, mail)).immediate();
}

export function readManageSignup(db: Database.Database, token: string, now: string): ManageView | null {
  if (!manageTokenShape(token)) return null;
  const row = db
    .prepare(
      `SELECT
         su.id AS signup_id,
         su.name AS name,
         su.email AS email,
         su.phone AS phone,
         su.notes AS notes,
         su.status AS status,
         su.reminders_off AS reminders_off,
         su.email_norm AS email_norm,
         su.token_expires_at AS token_expires_at,
         su.shift_id AS shift_id,
         s.event_id AS event_id,
         s.role AS role,
         e.title AS title,
         e.location AS location,
         e.tz AS tz,
         s.starts_at_utc AS starts_at_utc
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       JOIN events e ON e.id = s.event_id
       WHERE su.manage_token_hash = ? AND su.anonymized_at IS NULL`,
    )
    .get(sha256(token)) as ManageRow | undefined;
  if (!row || !row.token_expires_at || row.token_expires_at <= now) return null;
  if (row.status !== 'confirmed' && row.status !== 'cancelled') return null;
  if (!row.name || !row.email || !row.email_norm) return null;
  return {
    signupId: row.signup_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    status: row.status,
    remindersOff: row.reminders_off === 1,
    emailNorm: row.email_norm,
    shiftId: row.shift_id,
    eventId: row.event_id,
    role: row.role,
    location: row.location,
    eventTitle: row.title,
    when: formatInstantInZone(row.starts_at_utc, row.tz),
  };
}

function placeReservation(db: Database.Database, input: ReserveInput, emailNorm: string, operationKey: string): ReserveResult {
  const shift = db
    .prepare(
      `SELECT s.capacity AS capacity, s.cancelled AS cancelled, s.ends_at_utc AS ends_at_utc, s.starts_at_utc AS starts_at_utc,
              s.version AS version, s.role AS role, e.published AS published, e.title AS title, e.location AS location, e.tz AS tz
       FROM shifts s
       JOIN events e ON e.id = s.event_id
       WHERE s.id = ?`,
    )
    .get(input.shiftId) as
    | {
        capacity: number;
        cancelled: number;
        ends_at_utc: string;
        starts_at_utc: string;
        version: number;
        role: string;
        published: number;
        title: string;
        location: string;
        tz: string;
      }
    | undefined;
  const coordinator = input.audience === 'coordinator';
  if (!shift || (!coordinator && shift.published !== 1)) return { ok: false, reason: 'not_found' };
  if (shift.cancelled === 1 || shift.ends_at_utc <= input.now) return { ok: false, reason: 'closed' };

  const existing = findOperation(db, operationKey);
  if (existing) {
    if (existing.shiftId === input.shiftId && existing.emailNorm === emailNorm) {
      return { ok: true, signupId: existing.id, manageToken: null, replay: true };
    }
    return { ok: false, reason: 'conflict' };
  }
  if (confirmedPersonOnShift(db, input.shiftId, emailNorm, input.name)) return { ok: false, reason: 'duplicate' };

  const occupied = db
    .prepare(
      `SELECT COALESCE(SUM(group_size), 0) AS occupied
       FROM signups
       WHERE shift_id = ? AND status = 'confirmed'`,
    )
    .get(input.shiftId) as { occupied: number };
  if (Number(occupied.occupied) + 1 > shift.capacity) return { ok: false, reason: 'full' };

  const manageToken = randomBytes(32).toString('base64url');
  const expiresAt = formatUtc(Temporal.Instant.from(shift.ends_at_utc).add({ hours: MANAGE_TOKEN_TTL_HOURS }));
  const inserted = db
    .prepare(
      `INSERT INTO signups (
         shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
         group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
         created_at, updated_at, operation_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'confirmed', ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      input.shiftId,
      input.name,
      emailNorm,
      emailNorm,
      input.phone,
      0,
      null,
      null,
      input.notes,
      sha256(manageToken),
      expiresAt,
      input.now,
      input.now,
      operationKey,
    );
  const signupId = Number(inserted.lastInsertRowid);
  queueConfirmation(db, {
    signupId,
    shiftId: input.shiftId,
    shiftVersion: shift.version,
    token: manageToken,
    volunteerName: input.name,
    volunteerEmail: emailNorm,
    shift: shiftFacts(shift).facts,
    mail: input.mail,
    now: input.now,
  });
  rememberSignupContact(db, { name: input.name, email: emailNorm, phone: input.phone }, input.now);
  input.onReserved?.(signupId);
  return { ok: true, signupId, manageToken, replay: false };
}

type OperationRow = { id: number; shiftId: number; emailNorm: string };

function findOperation(db: Database.Database, operationKey: string): OperationRow | null {
  const row = db
    .prepare(
      `SELECT id AS id, shift_id AS shiftId, email_norm AS emailNorm
       FROM signups
       WHERE operation_key = ? AND email_norm IS NOT NULL`,
    )
    .get(operationKey) as OperationRow | undefined;
  return row ?? null;
}

/** True when this name and email already have a confirmed spot on the shift. */
export function confirmedPersonOnShift(db: Database.Database, shiftId: number, emailNorm: string, name: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM signups
       WHERE shift_id = ? AND email_norm = ? AND name = ? COLLATE NOCASE AND status = 'confirmed'
       LIMIT 1`,
    )
    .get(shiftId, emailNorm, name);
  return Boolean(row);
}

/** Shifts where this name and email are already confirmed. */
export function confirmedPersonShiftIds(db: Database.Database, emailNorm: string, name: string): number[] {
  const rows = db
    .prepare(
      `SELECT shift_id AS shift_id FROM signups
       WHERE email_norm = ? AND name = ? COLLATE NOCASE AND status = 'confirmed'`,
    )
    .all(emailNorm, name) as Array<{ shift_id: number }>;
  return rows.map((row) => row.shift_id);
}

function cancelConfirmed(db: Database.Database, hash: string, token: string, now: string, mail: MailIdentity): CancelResult {
  const row = db
    .prepare(
      `SELECT su.id AS id, su.status AS status, su.token_expires_at AS token_expires_at, su.anonymized_at AS anonymized_at,
              su.name AS name, su.email_norm AS email_norm, su.shift_id AS shift_id
       FROM signups su
       WHERE su.manage_token_hash = ?`,
    )
    .get(hash) as
    | {
        id: number;
        status: string;
        token_expires_at: string | null;
        anonymized_at: string | null;
        name: string | null;
        email_norm: string | null;
        shift_id: number;
      }
    | undefined;
  if (!row || row.anonymized_at || !row.token_expires_at || row.token_expires_at <= now) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.status === 'cancelled') return { ok: true, already: true };
  if (row.status !== 'confirmed' || !row.name || !row.email_norm) return { ok: false, reason: 'invalid' };
  const updated = db
    .prepare(
      `UPDATE signups
       SET status = 'cancelled', updated_at = ?
       WHERE manage_token_hash = ? AND status = 'confirmed' AND anonymized_at IS NULL AND token_expires_at > ?`,
    )
    .run(now, hash, now);
  if (updated.changes === 1) {
    cancelPendingConfirmations(db, row.id);
    cancelPendingReminders(db, row.id, 'The signup was cancelled before this reminder was sent.');
    const shift = loadShiftFacts(db, row.shift_id);
    if (shift) {
      queueCancellation(db, {
        signupId: row.id,
        shiftId: row.shift_id,
        shiftVersion: shift.version,
        token,
        volunteerName: row.name,
        volunteerEmail: row.email_norm,
        shift: shift.facts,
        mail,
        now,
      });
    }
    return { ok: true, already: false };
  }
  const again = db
    .prepare(`SELECT status AS status, token_expires_at AS token_expires_at FROM signups WHERE manage_token_hash = ?`)
    .get(hash) as { status: string; token_expires_at: string | null } | undefined;
  if (again?.status === 'cancelled' && again.token_expires_at && again.token_expires_at > now) {
    return { ok: true, already: true };
  }
  return { ok: false, reason: 'invalid' };
}

function shiftFacts(shift: {
  role: string;
  title: string;
  location: string;
  tz: string;
  starts_at_utc: string;
  ends_at_utc: string;
  version: number;
}): { version: number; facts: { role: string; eventTitle: string; location: string; whenLabel: string } } {
  const start = formatInstantInZone(shift.starts_at_utc, shift.tz);
  const end = formatInstantInZone(shift.ends_at_utc, shift.tz);
  return {
    version: shift.version,
    facts: {
      role: shift.role,
      eventTitle: shift.title,
      location: shift.location,
      whenLabel: `${start.dateLabel}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
    },
  };
}

function loadShiftFacts(db: Database.Database, shiftId: number) {
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
  return shift ? shiftFacts(shift) : null;
}

function manageTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueConstraint(err: unknown): boolean {
  return err instanceof Error && 'code' in err && String((err as { code: string }).code).includes('SQLITE_CONSTRAINT');
}



type ManageRow = {
  signup_id: number;
  name: string | null;
  email: string | null;
  email_norm: string | null;
  phone: string | null;
  notes: string | null;
  status: string;
  reminders_off: number;
  token_expires_at: string | null;
  shift_id: number;
  event_id: number;
  role: string;
  title: string;
  location: string;
  tz: string;
  starts_at_utc: string;
};
