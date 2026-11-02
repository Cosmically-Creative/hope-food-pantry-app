import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { absoluteUrl } from '../url.js';
import { escapeHtml } from './html.js';
import {
  renderCancellation,
  renderChanged,
  renderConfirmation,
  renderCoordinatorNotice,
  renderLocationChange,
  renderMagicLink,
  renderMoved,
  renderSwitched,
  type CoordinatorNoticeAction,
  type MailShift,
} from './templates.js';
import type { MailIdentity } from './types.js';

export type QueuedSignup = {
  signupId: number;
  shiftId: number;
  shiftVersion: number;
  token: string;
  volunteerName: string;
  volunteerEmail: string;
  groupSize?: number;
  shift: MailShift;
  mail: MailIdentity;
  now: string;
  linkNote?: string;
  /** Used when the letter cannot include the private /m/ link. The manage token is stored only as a hash. */
  pageUrl?: string;
};

/** Inserts one row per recipient. The same logical message does not get a second row. */
export function queueConfirmation(db: Database.Database, input: QueuedSignup): void {
  queue(db, 'confirmation', input, () => renderConfirmation({
    volunteerName: input.volunteerName,
    shift: input.shift,
    manageUrl: manageUrl(input),
    replyTo: input.mail.replyTo,
    groupSize: input.groupSize,
  }));
}

export function queueCancellation(db: Database.Database, input: QueuedSignup): void {
  queue(db, 'cancelled', input, () => renderCancellation({
    volunteerName: input.volunteerName,
    shift: input.shift,
    manageUrl: manageUrl(input),
    replyTo: input.mail.replyTo,
    linkNote: input.linkNote,
    groupSize: input.groupSize,
  }));
}

export function queueChanged(db: Database.Database, input: QueuedSignup, reason: 'edit' | 'move' | 'switch' = 'edit'): void {
  queue(db, 'changed', input, () => {
    const letter = {
      volunteerName: input.volunteerName,
      shift: input.shift,
      manageUrl: manageUrl(input),
      replyTo: input.mail.replyTo,
      groupSize: input.groupSize,
    };
    if (reason === 'move') return renderMoved(letter);
    if (reason === 'switch') return renderSwitched(letter);
    return renderChanged(letter);
  });
}

/**
 * One roster notice per active coordinator.
 * The private signup link is not included.
 * The same signup, action, shift version, and party size does not add a second row.
 */
export function queueCoordinatorNotices(
  db: Database.Database,
  input: {
    action: CoordinatorNoticeAction;
    signupId: number;
    shiftId: number;
    shiftVersion: number;
    volunteerName: string;
    volunteerEmail: string;
    groupSize?: number;
    previousGroupSize?: number;
    shift: MailShift;
    fromShift?: MailShift;
    mail: MailIdentity;
    now: string;
  },
): void {
  const coordinators = db
    .prepare(
      `SELECT name AS name, email AS email
       FROM coordinators
       WHERE active = 1
       ORDER BY id`,
    )
    .all() as { name: string; email: string }[];
  if (coordinators.length === 0) return;
  const phoneRow = db.prepare('SELECT phone AS phone FROM signups WHERE id = ?').get(input.signupId) as
    | { phone: string | null }
    | undefined;
  const rosterUrl = absoluteUrl(input.mail, `/admin/shifts/${input.shiftId}`);
  const insert = db.prepare(
    `INSERT INTO outbox (
       dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
       headers_json, send_after, attempts, status, created_at
     ) VALUES (?, ?, ?, 'notice', ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  );
  for (const coordinator of coordinators) {
    const rendered = renderCoordinatorNotice({
      coordinatorName: coordinator.name,
      volunteerName: input.volunteerName,
      volunteerEmail: input.volunteerEmail,
      phone: phoneRow?.phone ?? null,
      groupSize: input.groupSize,
      previousGroupSize: input.previousGroupSize,
      action: input.action,
      shift: input.shift,
      fromShift: input.fromShift,
      rosterUrl,
      replyTo: input.mail.replyTo,
    });
    insert.run(
      `notice:${input.action}:v${input.shiftVersion}:${input.groupSize ?? 1}:${input.signupId}:${coordinator.email}`,
      input.signupId,
      input.shiftId,
      coordinator.email,
      rendered.subject,
      rendered.text,
      rendered.html,
      JSON.stringify({ From: input.mail.from, 'Reply-To': input.mail.replyTo }),
      input.now,
      input.now,
    );
  }
}

export function queueMagicLink(
  db: Database.Database,
  input: { email: string; token: string; tokenHash: string; mail: MailIdentity; now: string },
): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE kind = 'magic_link' AND status = 'pending' AND to_email = ?`,
  ).run('A newer sign-in link replaced this message.', input.email);
  const rendered = renderMagicLink({
    signInUrl: absoluteUrl(input.mail, `/login/link/${input.token}`),
    replyTo: input.mail.replyTo,
  });
  db.prepare(
    `INSERT INTO outbox (
       dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
       headers_json, send_after, attempts, status, created_at
     ) VALUES (?, NULL, NULL, 'magic_link', ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
  ).run(
    `magic_link:${input.tokenHash}`,
    input.email,
    rendered.subject,
    rendered.text,
    rendered.html,
    JSON.stringify({ From: input.mail.from, 'Reply-To': input.mail.replyTo }),
    input.now,
    input.now,
  );
}

/** Pending confirmation or change mail is obsolete after the signup is cancelled. Sent mail cannot be recalled. */
export function cancelPendingConfirmations(db: Database.Database, signupId: number): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE signup_id = ? AND kind IN ('confirmation', 'changed') AND status = 'pending'`,
  ).run('The signup was cancelled before this message was sent.', signupId);
}

/** A reminder still waiting is not sent after the signup moves, is cancelled, or turns reminders off. Sent mail cannot be recalled. */
export function cancelPendingReminders(
  db: Database.Database,
  signupId: number,
  reason = 'The signup moved before this reminder was sent.',
): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE signup_id = ? AND kind = 'reminder' AND status = 'pending'`,
  ).run(reason, signupId);
}

/**
 * One location letter for every upcoming shift this person has on the event.
 * A newer location letter for the same person replaces one that is still waiting.
 * The private signup link is not included.
 */
export function queueLocationChange(
  db: Database.Database,
  input: {
    eventId: number;
    signupIds: number[];
    signupId: number;
    shiftId: number;
    volunteerName: string;
    volunteerEmail: string;
    eventTitle: string;
    location: string;
    shifts: Array<{ role: string; whenLabel: string }>;
    mail: MailIdentity;
    now: string;
  },
): void {
  const ids = [...new Set(input.signupIds)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((left, right) => left - right);
  if (ids.length === 0) return;
  const person = sha256(`${input.volunteerEmail}\0${input.volunteerName.trim().toLowerCase()}`).slice(0, 16);
  const place = sha256(input.location).slice(0, 12);
  const dedupe = `location:e${input.eventId}:${person}:${place}:${input.now}:s${ids.join('.')}`;
  const queued = db.prepare('SELECT id AS id FROM outbox WHERE dedupe_key = ?').get(dedupe);
  if (queued) return;
  db.prepare(
    `UPDATE outbox
     SET status = 'cancelled', last_error = ?
     WHERE kind = 'location' AND status = 'pending' AND to_email = ? AND dedupe_key LIKE ?`,
  ).run('A newer location email replaced this message.', input.volunteerEmail, `location:e${input.eventId}:${person}:%`);
  const rendered = renderLocationChange({
    volunteerName: input.volunteerName,
    eventTitle: input.eventTitle,
    location: input.location,
    shifts: input.shifts,
    replyTo: input.mail.replyTo,
  });
  db.prepare(
    `INSERT INTO outbox (
       dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
       headers_json, send_after, attempts, status, created_at
     ) VALUES (?, ?, ?, 'location', ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
  ).run(
    dedupe,
    input.signupId,
    input.shiftId,
    input.volunteerEmail,
    rendered.subject,
    rendered.text,
    rendered.html,
    JSON.stringify({ From: input.mail.from, 'Reply-To': input.mail.replyTo }),
    input.now,
    input.now,
  );
}

/** Pending letters still say the previous address. The signup link in each letter stays as it is. */
export function rewritePendingPlace(db: Database.Database, signupIds: number[], previous: string, next: string): void {
  const from = previous.trim();
  const to = next.trim();
  const ids = [...new Set(signupIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!from || from === to || ids.length === 0) return;
  const marks = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id AS id, body_text AS body_text, body_html AS body_html
       FROM outbox
       WHERE status = 'pending' AND kind IN ('confirmation', 'changed', 'cancelled') AND signup_id IN (${marks})`,
    )
    .all(...ids) as Array<{ id: number; body_text: string; body_html: string }>;
  const update = db.prepare('UPDATE outbox SET body_text = ?, body_html = ? WHERE id = ? AND status = ?');
  for (const row of rows) {
    const text = replacePlaceLine(row.body_text, from, to);
    const html = replacePlaceHtml(row.body_html, from, to);
    if (text === row.body_text && html === row.body_html) continue;
    update.run(text, html, row.id, 'pending');
  }
}

function replacePlaceLine(text: string, from: string, to: string): string {
  return text
    .split('\n')
    .flatMap((line) => (line === from ? (to ? [to] : []) : [line]))
    .join('\n');
}

function replacePlaceHtml(html: string, from: string, to: string): string {
  const old = `<br>${escapeHtml(from)}</p>`;
  const next = to ? `<br>${escapeHtml(to)}</p>` : '</p>';
  return html.replaceAll(old, next);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function queue(
  db: Database.Database,
  kind: 'confirmation' | 'cancelled' | 'changed',
  input: QueuedSignup,
  render: () => { subject: string; text: string; html: string },
): void {
  const rendered = render();
  db.prepare(
    `INSERT INTO outbox (
       dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
       headers_json, send_after, attempts, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  ).run(
    `${kind}:v${input.shiftVersion}:${input.signupId}:${input.volunteerEmail}`,
    input.signupId,
    input.shiftId,
    kind,
    input.volunteerEmail,
    rendered.subject,
    rendered.text,
    rendered.html,
    JSON.stringify({ From: input.mail.from, 'Reply-To': input.mail.replyTo }),
    input.now,
    input.now,
  );
}

function manageUrl(input: QueuedSignup): string {
  return input.pageUrl ?? absoluteUrl(input.mail, `/m/${input.token}`);
}
