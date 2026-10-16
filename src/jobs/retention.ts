import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { writeAudit } from '../auth/audit.js';
import { purgeRateHits } from '../rate-limit.js';
import { readRetentionMonths } from '../settings.js';
import { formatInstantInZone, formatUtc } from '../time.js';

/** Central Time, once each local date, after the weekly refill hour. */
export const RETENTION_ZONE = 'America/Chicago';
export const RETENTION_LOCAL_TIME = '01:00';
/** Volunteer mail keeps its recipient and body this long after it is finished. */
export const OUTBOX_KEEP_DAYS = 30;
/** Audit rows are counts and ids. They are kept for two years, separate from signup retention. */
export const AUDIT_KEEP_MONTHS = 24;

const JOB = 'retention';
const POLL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type RetentionResult = {
  signups: number;
  messages: number;
  sessions: number;
  loginTokens: number;
  auditRows: number;
  rateHits: number;
};

type OutboxRow = {
  id: number;
  signup_id: number | null;
  kind: string;
  status: string;
  dedupe_key: string;
  created_at: string;
  sent_at: string | null;
  delivery_unknown_at: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
};

/**
 * Removes personal details that are past their keep period. Safe to run more
 * than once. A name is cleared in the live database only. Downloaded files,
 * inboxes, and older copies of the database file are outside this cleanup.
 */
export function runRetention(db: Database.Database, now: string): RetentionResult {
  const result = db.transaction((): RetentionResult => {
    const signups = anonymizeSignups(db, now);
    const login = purgeLoginPayloadsIn(db, now);
    const auditRows = purgeAudit(db, now);
    const rateHits = purgeRateHits(db, now);
    const changed = signups + login.messages + login.sessions + login.loginTokens + auditRows;
    if (changed > 0) {
      writeAudit(db, null, 'retention.cleanup', {
        signups,
        messages: login.messages,
        sessions: login.sessions,
        loginTokens: login.loginTokens,
        auditRows,
      }, now);
    }
    return { signups, messages: login.messages, sessions: login.sessions, loginTokens: login.loginTokens, auditRows, rateHits };
  }).immediate();
  if (result.signups > 0) console.log(`Removed personal details from ${result.signups} old signups.`);
  return result;
}

/** Sign-in links, expired sessions, and expired sign-in messages. The hourly check uses this. */
export function purgeLoginPayloads(db: Database.Database, now: string): Pick<RetentionResult, 'messages' | 'sessions' | 'loginTokens'> {
  return db.transaction(() => purgeLoginPayloadsIn(db, now)).immediate();
}

/**
 * Runs the cleanup once per Central Time date, after 1:00. When 1:00 happens
 * twice, the second hour does nothing. A start before 1:00 does not record
 * the day, so the 1:00 run can still happen.
 */
export function runDueRetention(db: Database.Database, now: string): { ran: boolean; result: RetentionResult } {
  const clock = formatInstantInZone(now, RETENTION_ZONE);
  const empty = { signups: 0, messages: 0, sessions: 0, loginTokens: 0, auditRows: 0, rateHits: 0 };
  if (clock.time24 < RETENTION_LOCAL_TIME || alreadyRan(db, clock.date)) return { ran: false, result: empty };
  try {
    const result = runRetention(db, now);
    markRan(db, clock.date, now);
    return { ran: true, result };
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Retention cleanup failed.');
    return { ran: false, result: empty };
  }
}

export function startRetentionRunner(db: Database.Database, now: () => string): { stop: () => void } {
  return startRunner(POLL_MS, () => {
    const due = runDueRetention(db, now());
    return due.ran ? due.result.messages : 0;
  });
}

/** Expired sign-in messages, finished mail past 30 days, and rate-limit counters. Signup names stay on the daily run. */
export function startHourlyCleanupRunner(db: Database.Database, now: () => string): { stop: () => void } {
  return startRunner(HOUR_MS, () => {
    const login = purgeLoginPayloads(db, now());
    purgeRateHits(db, now());
    return login.messages;
  });
}

function startRunner(intervalMs: number, tickBody: () => number): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    try {
      const messages = tickBody();
      if (messages > 0) console.log(`Removed personal details from ${messages} old messages.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Retention cleanup failed.');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function anonymizeSignups(db: Database.Database, now: string): number {
  const months = readRetentionMonths(db);
  const rows = db
    .prepare(
      `SELECT su.id AS id, s.ends_at_utc AS ends_at_utc, e.tz AS tz
       FROM signups su
       JOIN shifts s ON s.id = su.shift_id
       JOIN events e ON e.id = s.event_id
       WHERE su.anonymized_at IS NULL`,
    )
    .all() as { id: number; ends_at_utc: string; tz: string }[];
  const update = db.prepare(
    `UPDATE signups
     SET name = NULL, email = NULL, email_norm = NULL, phone = NULL, is_minor = 0,
         guardian_name = NULL, guardian_email = NULL, notes = NULL,
         manage_token_hash = NULL, token_expires_at = NULL,
         anonymized_at = ?, updated_at = ?
     WHERE id = ? AND anonymized_at IS NULL`,
  );
  let count = 0;
  for (const row of rows) {
    let due = false;
    try {
      const ended = Temporal.Instant.from(row.ends_at_utc).toZonedDateTimeISO(row.tz);
      due = Temporal.Instant.compare(Temporal.Instant.from(now), ended.add({ months }).toInstant()) >= 0;
    } catch {
      console.error('Retention skipped a signup because its event time zone is not valid.');
      continue;
    }
    if (!due) continue;
    count += update.run(now, now, row.id).changes;
  }
  return count;
}

function purgeLoginPayloadsIn(db: Database.Database, now: string): Pick<RetentionResult, 'messages' | 'sessions' | 'loginTokens'> {
  const messages = purgeOutbox(db, now);
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  const loginTokens = db
    .prepare('DELETE FROM login_tokens WHERE used_at IS NOT NULL OR expires_at <= ?')
    .run(now).changes;
  return { messages, sessions, loginTokens };
}

function purgeOutbox(db: Database.Database, now: string): number {
  const cutoff = formatUtc(Temporal.Instant.from(now).subtract({ hours: OUTBOX_KEEP_DAYS * 24 }));
  const liveMagic = new Set(
    (
      db
        .prepare(
          `SELECT token_hash AS token_hash FROM login_tokens
           WHERE used_at IS NULL AND expires_at > ?`,
        )
        .all(now) as { token_hash: string }[]
    ).map((row) => row.token_hash),
  );
  const anonymized = new Set(
    (db.prepare('SELECT id AS id FROM signups WHERE anonymized_at IS NOT NULL').all() as { id: number }[]).map((row) => row.id),
  );
  const rows = db
    .prepare(
      `SELECT id AS id, signup_id AS signup_id, kind AS kind, status AS status, dedupe_key AS dedupe_key,
              created_at AS created_at, sent_at AS sent_at, delivery_unknown_at AS delivery_unknown_at,
              claimed_at AS claimed_at, lease_expires_at AS lease_expires_at
       FROM outbox
       WHERE dedupe_key NOT LIKE 'purged:%'`,
    )
    .all() as OutboxRow[];
  const update = db.prepare(
    `UPDATE outbox
     SET dedupe_key = ?, to_email = '', subject = '', body_text = '', body_html = '',
         headers_json = '{}', last_error = NULL,
         status = CASE WHEN status IN ('pending', 'sending') THEN 'cancelled' ELSE status END
     WHERE id = ?`,
  );
  let count = 0;
  for (const row of rows) {
    if (!messageDue(row, now, cutoff, liveMagic, anonymized)) continue;
    count += update.run(`purged:${row.id}`, row.id).changes;
  }
  return count;
}

function messageDue(row: OutboxRow, now: string, cutoff: string, liveMagic: Set<string>, anonymized: Set<number>): boolean {
  if (row.status === 'sending' && row.lease_expires_at && row.lease_expires_at > now) return false;
  if (row.signup_id !== null && anonymized.has(row.signup_id)) return true;
  if (row.kind === 'magic_link') {
    const hash = row.dedupe_key.startsWith('magic_link:') ? row.dedupe_key.slice('magic_link:'.length) : '';
    return hash.length === 0 || !liveMagic.has(hash);
  }
  const stamp = contentStamp(row);
  return stamp !== null && stamp <= cutoff;
}

function contentStamp(row: OutboxRow): string | null {
  if (row.status === 'sent') return row.sent_at ?? row.created_at;
  if (row.status === 'delivery_unknown') return row.delivery_unknown_at ?? row.claimed_at ?? row.created_at;
  if (row.status === 'pending' || row.status === 'sending' || row.status === 'failed' || row.status === 'cancelled') {
    return row.claimed_at ?? row.created_at;
  }
  return row.created_at;
}

function purgeAudit(db: Database.Database, now: string): number {
  const cutoff = formatUtc(
    Temporal.Instant.from(now).toZonedDateTimeISO(RETENTION_ZONE).subtract({ months: AUDIT_KEEP_MONTHS }).toInstant(),
  );
  return db.prepare('DELETE FROM audit WHERE at <= ?').run(cutoff).changes;
}

function alreadyRan(db: Database.Database, localDate: string): boolean {
  const row = db.prepare('SELECT 1 AS ready FROM job_runs WHERE job = ? AND scope = ? AND local_date = ?').get(JOB, RETENTION_ZONE, localDate);
  return Boolean(row);
}

function markRan(db: Database.Database, localDate: string, now: string): void {
  db.prepare('INSERT INTO job_runs (job, scope, local_date, ran_at) VALUES (?, ?, ?, ?)').run(JOB, RETENTION_ZONE, localDate, now);
}
