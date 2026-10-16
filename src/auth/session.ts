import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { formatUtc } from '../time.js';
import { cookiePath } from '../url.js';

export const SESSION_COOKIE = 'hope_session';
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

export type CoordinatorSession = {
  coordinatorId: number;
  role: 'admin' | 'coordinator';
  csrf: string;
  name: string;
};

type CookieConfig = { basePath: string; secureCookies: boolean };

export function insertSession(
  db: Database.Database,
  coordinatorId: number,
  now: string,
): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = formatUtc(Temporal.Instant.from(now).add({ seconds: SESSION_SECONDS }));
  db.prepare(
    `INSERT INTO sessions (id_hash, coordinator_id, csrf, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha256(token), coordinatorId, csrf, expiresAt, now, now);
  return { token, csrf };
}

/** Absolute 14-day expiry. last_seen_at updates, and expires_at does not move. */
export function readSession(db: Database.Database, cookieHeader: string | undefined, now: string): CoordinatorSession | null {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token || !TOKEN_SHAPE.test(token)) return null;
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT s.csrf AS csrf, s.expires_at AS expires_at, c.id AS id, c.role AS role, c.name AS name, c.active AS active
       FROM sessions s
       JOIN coordinators c ON c.id = s.coordinator_id
       WHERE s.id_hash = ?`,
    )
    .get(hash) as
    | { csrf: string; expires_at: string; id: number; role: string; name: string; active: number }
    | undefined;
  if (!row || row.active !== 1 || row.expires_at <= now) return null;
  if (row.role !== 'admin' && row.role !== 'coordinator') return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, hash);
  return { coordinatorId: row.id, role: row.role, csrf: row.csrf, name: row.name };
}

export function revokeSession(db: Database.Database, cookieHeader: string | undefined): void {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token || !TOKEN_SHAPE.test(token)) return;
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
}

export function csrfMatches(expected: string, received: string): boolean {
  if (!TOKEN_SHAPE.test(expected) || !TOKEN_SHAPE.test(received)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sessionSetCookie(config: CookieConfig, token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=${cookiePath(config)}; Max-Age=${SESSION_SECONDS}${secureFlag(config)}`;
}

export function sessionClearCookie(config: CookieConfig): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=${cookiePath(config)}; Max-Age=0${secureFlag(config)}`;
}

function secureFlag(config: CookieConfig): string {
  return config.secureCookies ? '; Secure' : '';
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
