import { createHmac, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { cancelPendingReminders } from './mail/queue.js';
import { renderReminder } from './mail/templates.js';
import type { MailIdentity } from './mail/types.js';
import { readReminderOffsets, readReplyTo } from './settings.js';
import { formatInstantInZone } from './time.js';
import { absoluteUrl } from './url.js';

export type ReminderPass = { queued: number; suppressed: number };

type DueSignup = {
  id: number;
  name: string;
  email_norm: string;
  version: number;
  starts_at_utc: string;
  ends_at_utc: string;
  role: string;
  title: string;
  location: string;
  tz: string;
  shift_id: number;
  group_size: number;
};

/**
 * Queues reminders that are due and still before the shift starts.
 * When more than one offset is already due, only the closest one is sent.
 * Older offsets are recorded as not sent, so a late signup does not get every missed reminder.
 * The same signup, offset, and shift version is not queued twice.
 * Offset hours and the reply-to address come from coordinator settings, or the defaults when none are saved.
 */
export function queueDueReminders(db: Database.Database, mail: MailIdentity, secret: string, now: string): ReminderPass {
  return db.transaction((): ReminderPass => {
    const offsets = readReminderOffsets(db);
    const activeMail = { ...mail, replyTo: readReplyTo(db, mail.replyTo) };
    const rows = db
      .prepare(
        `SELECT su.id AS id, su.name AS name, su.email_norm AS email_norm, su.group_size AS group_size,
                su.shift_id AS shift_id, s.version AS version, s.starts_at_utc AS starts_at_utc,
                s.ends_at_utc AS ends_at_utc, s.role AS role,
                e.title AS title, e.location AS location, e.tz AS tz
         FROM signups su
         JOIN shifts s ON s.id = su.shift_id
         JOIN events e ON e.id = s.event_id
         WHERE su.status = 'confirmed'
           AND su.reminders_off = 0
           AND su.anonymized_at IS NULL
           AND su.name IS NOT NULL
           AND su.email_norm IS NOT NULL
           AND s.cancelled = 0
           AND s.starts_at_utc > ?`,
      )
      .all(now) as DueSignup[];
    let queued = 0;
    let suppressed = 0;
    const nowInstant = Temporal.Instant.from(now);
    for (const row of rows) {
      const start = Temporal.Instant.from(row.starts_at_utc);
      const due = offsets.filter((offset) => {
        const dueAt = start.subtract({ hours: offset.hours });
        return Temporal.Instant.compare(nowInstant, dueAt) >= 0 && !alreadyQueued(db, row.id, offset.kind, row.version);
      });
      if (due.length === 0) continue;
      const nearest = due.reduce((closest, offset) => (offset.hours < closest.hours ? offset : closest));
      if (insertReminder(db, row, nearest.kind, activeMail, secret, now, 'pending')) queued += 1;
      for (const offset of due) {
        if (offset.kind === nearest.kind) continue;
        if (insertReminder(db, row, offset.kind, activeMail, secret, now, 'suppressed')) suppressed += 1;
      }
    }
    return { queued, suppressed };
  }).immediate();
}

const REMINDERS_OFF_REASON = 'Reminders were turned off before this message was sent.';

/** Turns reminders off for one signup. Confirmation, change, and cancellation mail still queue. */
export function disableReminders(
  db: Database.Database,
  signupId: number,
  now: string,
): { ok: true; already: boolean } | { ok: false } {
  return db.transaction((): { ok: true; already: boolean } | { ok: false } => {
    const row = db
      .prepare('SELECT reminders_off AS reminders_off FROM signups WHERE id = ? AND anonymized_at IS NULL')
      .get(signupId) as { reminders_off: number } | undefined;
    if (!row) return { ok: false };
    if (row.reminders_off !== 1) {
      db.prepare('UPDATE signups SET reminders_off = 1, updated_at = ? WHERE id = ? AND anonymized_at IS NULL').run(now, signupId);
    }
    cancelPendingReminders(db, signupId, REMINDERS_OFF_REASON);
    return { ok: true, already: row.reminders_off === 1 };
  }).immediate();
}

/** Turns reminders back on and restores a reminder that was cancelled only because they were off. */
export function enableReminders(
  db: Database.Database,
  signupId: number,
  now: string,
): { ok: true } | { ok: false } {
  return db.transaction((): { ok: true } | { ok: false } => {
    const row = db
      .prepare('SELECT reminders_off AS reminders_off FROM signups WHERE id = ? AND anonymized_at IS NULL')
      .get(signupId) as { reminders_off: number } | undefined;
    if (!row) return { ok: false };
    if (row.reminders_off === 1) {
      db.prepare('UPDATE signups SET reminders_off = 0, updated_at = ? WHERE id = ? AND anonymized_at IS NULL').run(now, signupId);
    }
    db.prepare(
      `UPDATE outbox
       SET status = 'pending', last_error = NULL
       WHERE signup_id = ? AND kind = 'reminder' AND status = 'cancelled' AND last_error = ?`,
    ).run(signupId, REMINDERS_OFF_REASON);
    return { ok: true };
  }).immediate();
}

export function issueReminderOffToken(secret: string, signupId: number): string {
  const id = String(signupId);
  const mac = createHmac('sha256', secret).update(`hope-reminder-off-v1\0${id}`).digest('base64url');
  return `${id}.${mac}`;
}

export function readReminderOffToken(secret: string, token: string): number | null {
  if (!/^([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{20,128})$/.test(token)) return null;
  const id = Number(token.slice(0, token.indexOf('.')));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const expected = issueReminderOffToken(secret, id);
  const left = Buffer.from(expected);
  const right = Buffer.from(token);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return id;
}

function alreadyQueued(db: Database.Database, signupId: number, kind: string, version: number): boolean {
  const row = db
    .prepare('SELECT signup_id FROM reminders_sent WHERE signup_id = ? AND kind = ? AND shift_version = ?')
    .get(signupId, kind, version);
  return Boolean(row);
}

function insertReminder(
  db: Database.Database,
  row: DueSignup,
  kind: string,
  mail: MailIdentity,
  secret: string,
  now: string,
  mode: 'pending' | 'suppressed',
): boolean {
  const unsubscribeUrl = absoluteUrl(mail, `/u/${issueReminderOffToken(secret, row.id)}`);
  const headers = reminderHeaders(mail, unsubscribeUrl);
  const volunteerId = insertOutbox(db, row, kind, mail, headers, unsubscribeUrl, now, mode);
  if (volunteerId === null) return false;
  const saved = db
    .prepare(
      `INSERT INTO reminders_sent (signup_id, kind, shift_version, outbox_id, queued_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (signup_id, kind, shift_version) DO NOTHING`,
    )
    .run(row.id, kind, row.version, volunteerId, now);
  return saved.changes === 1;
}

function insertOutbox(
  db: Database.Database,
  row: DueSignup,
  kind: string,
  mail: MailIdentity,
  headers: Record<string, string>,
  unsubscribeUrl: string,
  now: string,
  mode: 'pending' | 'suppressed',
): number | null {
  const rendered = mode === 'pending'
    ? renderReminder({
        volunteerName: row.name,
        shift: shiftFacts(row),
        unsubscribeUrl,
        replyTo: mail.replyTo,
        groupSize: Number(row.group_size),
      })
    : { subject: 'Reminder not sent', text: 'This reminder was not sent.', html: '<p>This reminder was not sent.</p>' };
  const saved = db
    .prepare(
      `INSERT INTO outbox (
         dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
         headers_json, send_after, attempts, status, created_at, last_error
       ) VALUES (?, ?, ?, 'reminder', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .run(
      `reminder:v${row.version}:${row.id}:${kind}:${row.email_norm}`,
      row.id,
      row.shift_id,
      row.email_norm,
      rendered.subject,
      rendered.text,
      rendered.html,
      JSON.stringify({ From: mail.from, 'Reply-To': mail.replyTo, ...headers }),
      now,
      mode === 'pending' ? 'pending' : 'cancelled',
      now,
      mode === 'pending' ? null : 'A closer reminder was already due, so this one was not sent.',
    );
  if (saved.changes !== 1) return null;
  return Number(saved.lastInsertRowid);
}

function reminderHeaders(mail: MailIdentity, unsubscribeUrl: string): Record<string, string> {
  const subject = encodeURIComponent('Stop reminder emails');
  return {
    'List-Unsubscribe': `<mailto:${mail.replyTo}?subject=${subject}>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function shiftFacts(row: DueSignup): { role: string; eventTitle: string; location: string; whenLabel: string } {
  const start = formatInstantInZone(row.starts_at_utc, row.tz);
  const end = formatInstantInZone(row.ends_at_utc, row.tz);
  return {
    role: row.role,
    eventTitle: row.title,
    location: row.location,
    whenLabel: `${start.dateLabel}, ${start.timeLabel} to ${end.timeLabel} ${end.abbreviation}`,
  };
}
