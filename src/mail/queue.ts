import type Database from 'better-sqlite3';
import { absoluteUrl } from '../url.js';
import { renderCancellation, renderChanged, renderConfirmation, renderMagicLink, renderMoved, renderSwitched, type MailShift } from './templates.js';
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
  return absoluteUrl(input.mail, `/m/${input.token}`);
}
