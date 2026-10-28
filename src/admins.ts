import type Database from 'better-sqlite3';
import { writeAudit } from './auth/audit.js';
import { EmailAddressError, normalizeEmail } from './email.js';
import { isUniqueConstraint } from './sqlite-error.js';

const MAX_NAME = 80;
const MAX_EMAIL = 254;
const CONTROL = /[\u0000-\u001F\u007F]/;

export type AdminAccount = {
  id: number;
  name: string;
  email: string;
};

export type AdminForm = {
  name: string;
  email: string;
};

export type AdminErrors = Partial<Record<'name' | 'email', string>>;

type AdminRow = { id: number; name: string; email: string; active: number };

export function listAdmins(db: Database.Database): AdminAccount[] {
  return db
    .prepare(
      `SELECT id AS id, name AS name, email AS email
       FROM coordinators
       WHERE active = 1 AND role = 'admin'
       ORDER BY name COLLATE NOCASE, email, id`,
    )
    .all() as AdminAccount[];
}

export function addAdmin(
  db: Database.Database,
  actorId: number,
  values: AdminForm,
  now: string,
): { ok: true; id: number; status: 'added' | 'restored' } | { ok: false; errors: AdminErrors } {
  const parsed = parseAdminForm(values);
  if (!parsed.ok) return parsed;
  try {
    return db.transaction(() => {
      const existing = db
        .prepare('SELECT id AS id, active AS active FROM coordinators WHERE email = ?')
        .get(parsed.email) as { id: number; active: number } | undefined;
      if (existing?.active === 1) return { ok: false as const, errors: { email: 'That address already has access.' } };
      if (existing) {
        db.prepare(`UPDATE coordinators SET name = ?, role = 'admin', active = 1 WHERE id = ?`).run(parsed.name, existing.id);
        writeAudit(db, actorId, 'admins.restore', { coordinatorId: existing.id }, now);
        return { ok: true as const, id: existing.id, status: 'restored' as const };
      }
      const inserted = db
        .prepare(
          `INSERT INTO coordinators (email, name, role, password_hash, active, created_at)
           VALUES (?, ?, 'admin', NULL, 1, ?)`,
        )
        .run(parsed.email, parsed.name, now);
      const id = Number(inserted.lastInsertRowid);
      writeAudit(db, actorId, 'admins.add', { coordinatorId: id }, now);
      return { ok: true as const, id, status: 'added' as const };
    }).immediate();
  } catch (err) {
    if (isUniqueConstraint(err)) return { ok: false, errors: { email: 'That address already has access.' } };
    throw err;
  }
}

export function readAdminRemoval(db: Database.Database, id: number): { admin: AdminAccount; last: boolean } | null {
  const admin = activeAdmin(db, id);
  if (!admin) return null;
  return { admin: { id: admin.id, name: admin.name, email: admin.email }, last: activeAdminCount(db) <= 1 };
}

export function deactivateAdmin(
  db: Database.Database,
  actorId: number,
  id: number,
  now: string,
): { ok: true } | { ok: false; reason: 'missing' | 'last' } {
  return db.transaction(() => {
    const admin = activeAdmin(db, id);
    if (!admin) return { ok: false as const, reason: 'missing' as const };
    if (activeAdminCount(db) <= 1) return { ok: false as const, reason: 'last' as const };
    db.prepare('UPDATE coordinators SET active = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE coordinator_id = ?').run(id);
    db.prepare('UPDATE login_tokens SET used_at = ? WHERE coordinator_id = ? AND used_at IS NULL').run(now, id);
    db.prepare(
      `UPDATE outbox
       SET status = 'cancelled', last_error = ?
       WHERE kind = 'magic_link' AND status = 'pending' AND to_email = ?`,
    ).run('An administrator removed this sign-in link.', admin.email);
    db.prepare(
      `UPDATE outbox
       SET status = 'cancelled', last_error = ?
       WHERE kind = 'notice' AND status = 'pending' AND to_email = ?`,
    ).run('That coordinator no longer has access.', admin.email);
    writeAudit(db, actorId, 'admins.remove', { coordinatorId: id }, now);
    return { ok: true as const };
  }).immediate();
}

function activeAdmin(db: Database.Database, id: number): AdminRow | null {
  const row = db
    .prepare(
      `SELECT id AS id, name AS name, email AS email, active AS active
       FROM coordinators
       WHERE id = ? AND active = 1 AND role = 'admin'`,
    )
    .get(id) as AdminRow | undefined;
  return row ?? null;
}

function activeAdminCount(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM coordinators WHERE active = 1 AND role = 'admin'`).get() as { n: number };
  return row.n;
}

function parseAdminForm(values: AdminForm): { ok: true; name: string; email: string } | { ok: false; errors: AdminErrors } {
  const errors: AdminErrors = {};
  const nameRaw = values.name.normalize('NFC').trim();
  if (!nameRaw) errors.name = 'Enter a name.';
  else if (CONTROL.test(values.name)) errors.name = 'Enter a name without line breaks.';
  else if (nameRaw.length > MAX_NAME) errors.name = `Use ${MAX_NAME} characters or fewer.`;

  let email = '';
  try {
    email = normalizeEmail(values.email);
    if (email.length > MAX_EMAIL || CONTROL.test(values.email)) errors.email = 'Enter an email address.';
  } catch (err) {
    if (!(err instanceof EmailAddressError)) throw err;
    errors.email = 'Enter an email address.';
  }
  if (errors.name || errors.email) return { ok: false, errors };
  return { ok: true, name: nameRaw, email };
}
