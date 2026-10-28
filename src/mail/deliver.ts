import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { formatUtc } from '../time.js';
import { redactMailError } from './redact.js';
import type { MailDelivery, Mailer, OutboundMail } from './types.js';

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BATCH = 20;

type ClaimedRow = {
  id: number;
  signup_id: number | null;
  kind: string;
  dedupe_key: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string;
  headers_json: string;
  attempts: number;
};

/**
 * Claims due confirmation, change, cancellation, reminder, sign-in, and coordinator notice mail, then sends outside the database transaction.
 * An expired sending lease becomes delivery_unknown and is not sent again.
 * sent_at means the provider accepted the message.
 */
export async function deliverDueMail(
  db: Database.Database,
  mailer: Mailer,
  now: string,
  random: () => number = Math.random,
): Promise<number> {
  let accepted = 0;
  for (let index = 0; index < BATCH; index += 1) {
    const claimed = claimNext(db, now);
    if (!claimed) break;
    const reason = obsoleteReason(db, claimed, now);
    if (reason) {
      settle(db, claimed.id, { result: 'failed', error: reason }, now, random, 'cancelled');
      continue;
    }
    let delivery: MailDelivery;
    try {
      delivery = await mailer.send(outbound(claimed));
    } catch (err) {
      delivery = { result: 'unknown', error: redactMailError(err instanceof Error ? err.message : 'Mail send failed.') };
    }
    settle(db, claimed.id, delivery, now, random);
    if (delivery.result === 'sent') accepted += 1;
  }
  return accepted;
}

export function retryDelayMs(attempts: number, random: () => number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60 * 1000);
  const unit = random();
  const jitter = 0.8 + (Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0) * 0.4;
  return Math.round(base * jitter);
}

function claimNext(db: Database.Database, now: string): ClaimedRow | null {
  const leaseEnd = formatUtc(Temporal.Instant.from(now).add({ milliseconds: LEASE_MS }));
  return db.transaction(() => {
    db.prepare(
      `UPDATE outbox
       SET status = 'delivery_unknown', delivery_unknown_at = ?, last_error = ?
       WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    ).run(now, 'The sending lease expired before a result was recorded.', now);
    const next = db
      .prepare(
        `SELECT id AS id
         FROM outbox
         WHERE status = 'pending' AND send_after <= ? AND kind IN ('confirmation', 'cancelled', 'changed', 'reminder', 'magic_link', 'notice')
         ORDER BY id
         LIMIT 1`,
      )
      .get(now) as { id: number } | undefined;
    if (!next) return null;
    const claimed = db
      .prepare(
        `UPDATE outbox
         SET status = 'sending', attempts = attempts + 1, claimed_at = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, leaseEnd, next.id);
    if (claimed.changes !== 1) return null;
    return db
      .prepare(
        `SELECT id, signup_id, kind, dedupe_key, to_email, subject, body_text, body_html, headers_json, attempts
         FROM outbox WHERE id = ?`,
      )
      .get(next.id) as ClaimedRow;
  }).immediate();
}

function obsoleteReason(db: Database.Database, row: ClaimedRow, now: string): string | null {
  if (row.kind === 'magic_link') return magicLinkReason(db, row, now);
  if (row.kind === 'notice') return noticeReason(db, row);
  if (row.signup_id === null) return 'The signup is no longer available.';
  const signup = db
    .prepare(
      `SELECT su.status AS status, su.token_expires_at AS token_expires_at, su.anonymized_at AS anonymized_at,
              su.reminders_off AS reminders_off,
              s.cancelled AS shift_cancelled, s.version AS version, s.starts_at_utc AS starts_at_utc
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       WHERE su.id = ?`,
    )
    .get(row.signup_id) as
    | {
        status: string;
        token_expires_at: string | null;
        anonymized_at: string | null;
        reminders_off: number;
        shift_cancelled: number;
        version: number;
        starts_at_utc: string;
      }
    | undefined;
  if (!signup || signup.anonymized_at) return 'The signup is no longer available.';
  if (row.kind === 'reminder') return reminderReason(row, signup, now);
  if (!signup.token_expires_at || signup.token_expires_at <= now) return 'The manage link expired before this message was sent.';
  if (row.kind === 'confirmation' && (signup.status !== 'confirmed' || signup.shift_cancelled === 1)) {
    return 'The signup changed before this message was sent.';
  }
  if (row.kind === 'changed') {
    const version = changedVersion(row.dedupe_key);
    if (signup.status !== 'confirmed' || signup.shift_cancelled === 1 || version !== signup.version) {
      return 'The shift changed again before this message was sent.';
    }
  }
  if (row.kind === 'cancelled' && signup.status !== 'cancelled') return 'The signup is not cancelled.';
  return null;
}

function noticeReason(db: Database.Database, row: ClaimedRow): string | null {
  if (row.signup_id === null) return 'The signup is no longer available.';
  const signup = db.prepare('SELECT anonymized_at AS anonymized_at FROM signups WHERE id = ?').get(row.signup_id) as
    | { anonymized_at: string | null }
    | undefined;
  if (!signup || signup.anonymized_at) return 'The signup is no longer available.';
  const coordinator = db.prepare('SELECT id AS id FROM coordinators WHERE email = ? AND active = 1').get(row.to_email);
  if (!coordinator) return 'That coordinator no longer has access.';
  return null;
}

function magicLinkReason(db: Database.Database, row: ClaimedRow, now: string): string | null {
  const match = /^magic_link:([a-f0-9]{64})$/.exec(row.dedupe_key);
  const hash = match?.[1];
  if (!hash) return 'The sign-in link is no longer available.';
  const token = db
    .prepare(
      `SELECT t.used_at AS used_at, t.expires_at AS expires_at, c.active AS active
       FROM login_tokens t
       JOIN coordinators c ON c.id = t.coordinator_id
       WHERE t.token_hash = ?`,
    )
    .get(hash) as { used_at: string | null; expires_at: string; active: number } | undefined;
  if (!token || token.used_at !== null || token.expires_at <= now || token.active !== 1) {
    return 'The sign-in link is no longer available.';
  }
  return null;
}

function reminderReason(
  row: ClaimedRow,
  signup: { status: string; reminders_off: number; shift_cancelled: number; version: number; starts_at_utc: string; token_expires_at: string | null },
  now: string,
): string | null {
  const version = reminderVersion(row.dedupe_key);
  if (signup.status !== 'confirmed' || signup.reminders_off === 1) {
    return signup.reminders_off === 1
      ? 'Reminders were turned off before this message was sent.'
      : 'The signup changed before this reminder was sent.';
  }
  if (signup.shift_cancelled === 1 || version !== signup.version) return 'The shift changed before this reminder was sent.';
  if (signup.starts_at_utc <= now) return 'The shift started before this reminder was sent.';
  if (!signup.token_expires_at || signup.token_expires_at <= now) return 'The manage link expired before this message was sent.';
  return null;
}

function reminderVersion(dedupeKey: string): number | null {
  const match = /^reminder:v([1-9][0-9]*):/.exec(dedupeKey);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function changedVersion(dedupeKey: string): number | null {
  const match = /^changed:v([1-9][0-9]*):/.exec(dedupeKey);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function outbound(row: ClaimedRow): OutboundMail {
  const stored = JSON.parse(row.headers_json) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key === 'From' || key === 'Reply-To' || typeof value !== 'string') continue;
    headers[key] = value;
  }
  return {
    from: stored.From ?? '',
    to: row.to_email,
    replyTo: stored['Reply-To'] ?? '',
    subject: row.subject,
    text: row.body_text,
    html: row.body_html,
    headers,
  };
}

function settle(
  db: Database.Database,
  id: number,
  delivery: MailDelivery,
  now: string,
  random: () => number,
  force?: 'cancelled',
): void {
  if (force === 'cancelled') {
    db.prepare(
      `UPDATE outbox
       SET status = 'cancelled', last_error = ?, lease_expires_at = NULL
       WHERE id = ? AND status = 'sending'`,
    ).run(delivery.result === 'failed' ? delivery.error : 'The message was not sent.', id);
    return;
  }
  if (delivery.result === 'sent') {
    db.prepare(
      `UPDATE outbox
       SET status = 'sent', provider_id = ?, sent_at = ?, last_error = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'sending'`,
    ).run(delivery.providerId, now, id);
    db.prepare('UPDATE reminders_sent SET sent_at = ? WHERE outbox_id = ? AND sent_at IS NULL').run(now, id);
    return;
  }
  const attempts = db.prepare('SELECT attempts AS attempts FROM outbox WHERE id = ?').get(id) as { attempts: number };
  const error = redactMailError(delivery.error);
  if (delivery.result === 'unknown') {
    db.prepare(
      `UPDATE outbox
       SET status = 'delivery_unknown', delivery_unknown_at = ?, last_error = ?, lease_expires_at = NULL
       WHERE id = ? AND status = 'sending'`,
    ).run(now, error, id);
    console.error(`Mail result unknown for outbox ${id}.`);
    return;
  }
  if (delivery.result === 'retry' && attempts.attempts < MAX_ATTEMPTS) {
    const sendAfter = formatUtc(Temporal.Instant.from(now).add({ milliseconds: retryDelayMs(attempts.attempts, random) }));
    db.prepare(
      `UPDATE outbox
       SET status = 'pending', send_after = ?, last_error = ?, claimed_at = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'sending'`,
    ).run(sendAfter, error, id);
    return;
  }
  db.prepare(
    `UPDATE outbox
     SET status = 'failed', last_error = ?, lease_expires_at = NULL
     WHERE id = ? AND status = 'sending'`,
  ).run(error, id);
  console.error(`Mail result failed for outbox ${id}.`);
}
