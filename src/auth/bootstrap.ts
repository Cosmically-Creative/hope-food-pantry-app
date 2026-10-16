import type Database from 'better-sqlite3';
import { normalizeEmail } from '../email.js';
import { isUniqueConstraint } from '../sqlite-error.js';
import { writeAudit } from './audit.js';

/**
 * Inserts one administrator when the coordinators table is empty.
 * A later start does not overwrite that account, even if the configured address changed.
 */
export function bootstrapAdmin(db: Database.Database, email: string, now: string): { created: boolean } {
  const normalized = normalizeEmail(email);
  try {
    return db.transaction(() => {
      const count = db.prepare('SELECT COUNT(*) AS n FROM coordinators').get() as { n: number };
      if (count.n > 0) return { created: false };
      const inserted = db
        .prepare(
          `INSERT INTO coordinators (email, name, role, password_hash, active, created_at)
           VALUES (?, 'Administrator', 'admin', NULL, 1, ?)`,
        )
        .run(normalized, now);
      writeAudit(db, null, 'bootstrap', { coordinatorId: Number(inserted.lastInsertRowid) }, now);
      return { created: true };
    }).immediate();
  } catch (err) {
    if (isUniqueConstraint(err)) return { created: false };
    throw err;
  }
}
