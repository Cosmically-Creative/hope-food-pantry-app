import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { normalizeEmail } from './email.js';
import { formatUtc } from './time.js';

/** Initial public limits from the October 14, 2026 specification. */
export const SIGNUP_IP_LIMIT = 5;
export const SIGNUP_IP_WINDOW_MS = 10 * 60 * 1000;
export const SIGNUP_EMAIL_LIMIT = 3;
export const SWITCH_IP_LIMIT = 10;
export const SWITCH_RECIPIENT_LIMIT = 5;
export const MANAGE_TOKEN_LIMIT = 20;
export const LOGIN_EMAIL_LIMIT = 3;
export const LOGIN_IP_LIMIT = 10;
export const LOGIN_TOKEN_LIMIT = 20;
const LOGIN_WINDOW_MS = 60 * 60 * 1000;
/** Longer than a local signup day, which is the longest limit window. */
const RATE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** Deletes limit counters older than the retention margin. The hourly cleanup uses this too. */
export function purgeRateHits(db: Database.Database, now: string): number {
  const cutoff = formatUtc(Temporal.Instant.from(now).subtract({ milliseconds: RATE_RETENTION_MS }));
  return db.prepare('DELETE FROM rate_hits WHERE window_start < ?').run(cutoff).changes;
}

export type RateDecision = { limited: false } | { limited: true; retryAfter: number };

/**
 * Counts validated public switch attempts, not the rotating signup id or token.
 * Check and charge every bucket atomically so a blocked recipient cannot consume
 * another person's allowance.
 */
export function recordSwitchAttempt(
  db: Database.Database,
  secret: string,
  now: string,
  timeZone: string,
  ip: string,
  emails: string[],
): RateDecision {
  const recipientWindow = dayWindow(now, timeZone);
  const buckets = [
    { kind: 'switch-ip', id: ip, limit: SWITCH_IP_LIMIT, window: ipWindow(now) },
    ...[...new Set(emails.map(normalizeEmail))].map((id) => ({
      kind: 'switch-recipient', id, limit: SWITCH_RECIPIENT_LIMIT, window: recipientWindow,
    })),
  ].map((bucket) => ({
    ...bucket,
    key: createHmac('sha256', secret).update(`${bucket.kind}\0${bucket.id}`).digest('hex'),
  }));
  return db.transaction((): RateDecision => {
    purgeRateHits(db, now);
    const read = db.prepare('SELECT count FROM rate_hits WHERE key = ? AND window_start = ?');
    let retryAfter = 0;
    for (const bucket of buckets) {
      const row = read.get(bucket.key, bucket.window.start) as { count: number } | undefined;
      if (row && row.count >= bucket.limit) retryAfter = Math.max(retryAfter, bucket.window.retryAfter);
    }
    if (retryAfter > 0) return { limited: true, retryAfter };
    const increment = db.prepare(
      `INSERT INTO rate_hits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1`,
    );
    for (const bucket of buckets) increment.run(bucket.key, bucket.window.start);
    return { limited: false };
  }).immediate();
}

/**
 * Counts signup attempts. Keys are HMAC digests, so the table does not store
 * raw email addresses or IP addresses. The email allowance counts only after
 * Turnstile and field checks pass, so a failed widget cannot lock someone out
 * for the day. The IP allowance counts every signup POST.
 */
export function recordSignupIp(db: Database.Database, secret: string, now: string, ip: string): RateDecision {
  return record(db, secret, now, { kind: 'signup-ip', id: ip, limit: SIGNUP_IP_LIMIT, window: ipWindow(now) });
}

/** Counts unknown or expired manage links. A valid link does not use this allowance. */
export function recordInvalidManageToken(db: Database.Database, secret: string, now: string, ip: string): RateDecision {
  return record(db, secret, now, {
    kind: 'manage-token',
    id: ip,
    limit: MANAGE_TOKEN_LIMIT,
    window: ipWindow(now),
  });
}

/** Counts sign-in requests from one network. A failed check still uses this allowance. */
export function recordLoginIp(db: Database.Database, secret: string, now: string, ip: string): RateDecision {
  return record(db, secret, now, {
    kind: 'login-ip',
    id: ip,
    limit: LOGIN_IP_LIMIT,
    window: fixedWindow(now, LOGIN_WINDOW_MS),
  });
}

/** Counts sign-in requests for one address after the check succeeds, whether or not a coordinator uses it. */
export function recordLoginEmail(db: Database.Database, secret: string, now: string, emailNorm: string): RateDecision {
  return record(db, secret, now, {
    kind: 'login-email',
    id: emailNorm,
    limit: LOGIN_EMAIL_LIMIT,
    window: fixedWindow(now, LOGIN_WINDOW_MS),
  });
}

/** Counts invalid reminder opt-out links. A valid link does not use this allowance. */
export function recordInvalidUnsubscribe(db: Database.Database, secret: string, now: string, ip: string): RateDecision {
  return record(db, secret, now, {
    kind: 'reminder-off',
    id: ip,
    limit: MANAGE_TOKEN_LIMIT,
    window: ipWindow(now),
  });
}

/** Counts invalid sign-in links. A valid link does not use this allowance. */
export function recordInvalidLoginToken(db: Database.Database, secret: string, now: string, ip: string): RateDecision {
  return record(db, secret, now, {
    kind: 'login-token',
    id: ip,
    limit: LOGIN_TOKEN_LIMIT,
    window: ipWindow(now),
  });
}

export function recordSignupEmail(
  db: Database.Database,
  secret: string,
  now: string,
  timeZone: string,
  emailNorm: string,
): RateDecision {
  return record(db, secret, now, {
    kind: 'signup-email',
    id: emailNorm,
    limit: SIGNUP_EMAIL_LIMIT,
    window: dayWindow(now, timeZone),
  });
}

function record(
  db: Database.Database,
  secret: string,
  now: string,
  input: { kind: string; id: string; limit: number; window: { start: string; retryAfter: number } },
): RateDecision {
  const key = createHmac('sha256', secret).update(`${input.kind}\0${input.id}`).digest('hex');
  const count = db.transaction(() => {
    purgeRateHits(db, now);
    const row = db
      .prepare(
        `INSERT INTO rate_hits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .get(key, input.window.start) as { count: number };
    return row.count;
  }).immediate();
  if (count > input.limit) return { limited: true, retryAfter: input.window.retryAfter };
  return { limited: false };
}

function ipWindow(now: string): { start: string; retryAfter: number } {
  return fixedWindow(now, SIGNUP_IP_WINDOW_MS);
}

function fixedWindow(now: string, windowMs: number): { start: string; retryAfter: number } {
  const epoch = Temporal.Instant.from(now).epochMilliseconds;
  const startMs = Math.floor(epoch / windowMs) * windowMs;
  const retryAfter = Math.max(1, Math.ceil((startMs + windowMs - epoch) / 1000));
  return { start: formatUtc(Temporal.Instant.fromEpochMilliseconds(startMs)), retryAfter };
}

function dayWindow(now: string, timeZone: string): { start: string; retryAfter: number } {
  const zoned = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone);
  const start = zoned.startOfDay();
  const next = start.add({ days: 1 });
  const retryAfter = Math.max(
    1,
    Math.ceil((next.toInstant().epochMilliseconds - zoned.epochMilliseconds) / 1000),
  );
  return { start: formatUtc(start.toInstant()), retryAfter };
}
