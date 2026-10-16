import type Database from 'better-sqlite3';
import { normalizeEmail } from '../email.js';
import { writeAudit } from './audit.js';

/**
 * Host-only recovery. There is no web page for this.
 * Revokes sessions and unused sign-in links. Optionally replaces the sign-in address.
 */
export function recoverCoordinator(
  db: Database.Database,
  input: { email: string; replaceWith?: string; now: string },
): { coordinatorId: number } {
  const email = normalizeEmail(input.email);
  const next = input.replaceWith ? normalizeEmail(input.replaceWith) : null;
  return db.transaction(() => {
    const row = db.prepare('SELECT id AS id FROM coordinators WHERE email = ?').get(email) as { id: number } | undefined;
    if (!row) throw new Error('No coordinator has that address.');
    if (next && next !== email) {
      const taken = db.prepare('SELECT id AS id FROM coordinators WHERE email = ?').get(next);
      if (taken) throw new Error('Another coordinator already uses the new address.');
      db.prepare('UPDATE coordinators SET email = ? WHERE id = ?').run(next, row.id);
    }
    db.prepare('DELETE FROM sessions WHERE coordinator_id = ?').run(row.id);
    db.prepare('UPDATE login_tokens SET used_at = ? WHERE coordinator_id = ? AND used_at IS NULL').run(input.now, row.id);
    db.prepare(
      `UPDATE outbox
       SET status = 'cancelled', last_error = ?
       WHERE kind = 'magic_link' AND status = 'pending' AND to_email IN (?, ?)`,
    ).run('A host recovery replaced this sign-in link.', email, next ?? email);
    writeAudit(db, null, 'host.recover', { coordinatorId: row.id }, input.now);
    return { coordinatorId: row.id };
  }).immediate();
}
