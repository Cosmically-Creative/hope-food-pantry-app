import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type Database from 'better-sqlite3';
import { normalizeEmail } from '../email.js';
import { queueMagicLink } from '../mail/queue.js';
import type { MailIdentity } from '../mail/types.js';
import { formatUtc } from '../time.js';
import { writeAudit } from './audit.js';
import { insertSession } from './session.js';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;
const LOGIN_PROOF = 'hope-login-v1\0';
const LINK_MINUTES = 15;

export function requestMagicLink(
  db: Database.Database,
  input: { email: string; now: string; mail: MailIdentity },
): { queued: boolean } {
  let emailNorm: string;
  try {
    emailNorm = normalizeEmail(input.email);
  } catch {
    return { queued: false };
  }
  return db.transaction(() => {
    const coordinator = db
      .prepare('SELECT id AS id, active AS active FROM coordinators WHERE email = ?')
      .get(emailNorm) as { id: number; active: number } | undefined;
    if (!coordinator || coordinator.active !== 1) return { queued: false };
    db.prepare('UPDATE login_tokens SET used_at = ? WHERE coordinator_id = ? AND used_at IS NULL').run(input.now, coordinator.id);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const expiresAt = formatUtc(Temporal.Instant.from(input.now).add({ minutes: LINK_MINUTES }));
    db.prepare(
      `INSERT INTO login_tokens (token_hash, coordinator_id, expires_at, used_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(tokenHash, coordinator.id, expiresAt, input.now);
    queueMagicLink(db, { email: emailNorm, token, tokenHash, mail: input.mail, now: input.now });
    return { queued: true };
  }).immediate();
}

/** Reads a sign-in link without using it. Email scanners that only open the link stop here. */
export function loginLinkOpen(db: Database.Database, token: string, now: string): boolean {
  const row = lookup(db, token);
  return Boolean(row && row.used_at === null && row.expires_at > now && row.active === 1);
}

export function consumeLoginLink(
  db: Database.Database,
  token: string,
  now: string,
): { ok: true; sessionToken: string; csrf: string } | { ok: false } {
  if (!TOKEN_SHAPE.test(token)) return { ok: false };
  const hash = sha256(token);
  return db.transaction((): { ok: true; sessionToken: string; csrf: string } | { ok: false } => {
    const row = lookup(db, token);
    if (!row || row.used_at !== null || row.expires_at <= now || row.active !== 1) return { ok: false };
    const used = db
      .prepare(
        `UPDATE login_tokens
         SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, hash, now);
    if (used.changes !== 1) return { ok: false };
    const session = insertSession(db, row.coordinator_id, now);
    writeAudit(db, row.coordinator_id, 'login', {}, now);
    return { ok: true as const, sessionToken: session.token, csrf: session.csrf };
  }).immediate();
}

export function issueLoginProof(secret: string, token: string): string {
  return createHmac('sha256', secret).update(`${LOGIN_PROOF}${token}`).digest('base64url');
}

export function loginProofMatches(secret: string, token: string, proof: string): boolean {
  const expected = issueLoginProof(secret, token);
  if (!TOKEN_SHAPE.test(proof) || !TOKEN_SHAPE.test(expected)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(proof);
  return left.length === right.length && timingSafeEqual(left, right);
}

function lookup(db: Database.Database, token: string): { coordinator_id: number; expires_at: string; used_at: string | null; active: number } | null {
  if (!TOKEN_SHAPE.test(token)) return null;
  const row = db
    .prepare(
      `SELECT t.coordinator_id AS coordinator_id, t.expires_at AS expires_at, t.used_at AS used_at, c.active AS active
       FROM login_tokens t
       JOIN coordinators c ON c.id = t.coordinator_id
       WHERE t.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { coordinator_id: number; expires_at: string; used_at: string | null; active: number }
    | undefined;
  return row ?? null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
