import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  applyMigrations,
  defaultMigrationsDir,
  openAppDatabase,
  openDatabaseFile,
} from '../src/db.js';
import { devEnv, productionEnv } from './env.js';

const dirs: string[] = [];
const INSTANT = '2026-10-20T14:00:00.000Z';
const LATER = '2026-10-20T17:00:00.000Z';

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hope-volunteer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database startup', () => {
  it('applies the real schema once, in WAL mode, with foreign keys on', async () => {
    const dataDir = path.join(makeDir(), 'data');
    const config = loadConfig(devEnv({ DATA_DIR: dataDir }));
    const db = await openAppDatabase(config);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
          name: string;
        }[]
      )
        .map((row) => row.name)
        .sort();
      expect(names).toEqual(
        [
          'audit',
          'coordinators',
          'events',
          'job_runs',
          'login_tokens',
          'outbox',
          'rate_hits',
          'reminders_sent',
          'schema_migrations',
          'sessions',
          'settings',
          'shift_templates',
          'shifts',
          'signups',
        ].sort(),
      );
      const first = db.prepare('SELECT name, checksum, applied_at FROM schema_migrations').get();
      const again = await applyMigrations(db, { migrationsDir: defaultMigrationsDir() });
      expect(again.applied).toEqual([]);
      expect(db.prepare('SELECT name, checksum, applied_at FROM schema_migrations').get()).toEqual(first);
    } finally {
      db.close();
    }
  });

  it('backs up an existing production database before a new migration and not before the first one', async () => {
    const root = makeDir();
    const migrations = path.join(root, 'migrations');
    const dataDir = path.join(root, 'data');
    mkdirSync(migrations);
    copyFileSync(path.join(defaultMigrationsDir(), '001_init.sql'), path.join(migrations, '001_init.sql'));
    const config = loadConfig(productionEnv(dataDir));
    const first = await openAppDatabase(config, { migrationsDir: migrations });
    first.close();
    expect(readdirSync(dataDir).includes('backups')).toBe(false);

    writeFileSync(
      path.join(migrations, '002_probe.sql'),
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('probe', '"ok"', '${INSTANT}');\n`,
    );
    const second = await openAppDatabase(config, { migrationsDir: migrations });
    try {
      expect(second.prepare(`SELECT value_json FROM settings WHERE key = 'probe'`).get()).toEqual({
        value_json: '"ok"',
      });
      const backups = readdirSync(path.join(dataDir, 'backups'));
      expect(backups.some((name) => name.startsWith('pre-migrate-') && name.endsWith('.db'))).toBe(true);
      const backupName = backups.find((name) => name.startsWith('pre-migrate-'));
      if (!backupName) throw new Error('missing backup');
      const backup = new Database(path.join(dataDir, 'backups', backupName), { readonly: true, fileMustExist: true });
      try {
        expect(backup.pragma('journal_mode', { simple: true })).toBe('delete');
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(backup.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'probe'`).get()).toEqual({ n: 0 });
        expect(backup.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 0 });
      } finally {
        backup.close();
      }
    } finally {
      second.close();
    }
  });

  it('does not apply a migration when the pre-migration backup fails', async () => {
    const root = makeDir();
    const migrations = path.join(root, 'migrations');
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, '001_init.sql'), 'CREATE TABLE marker (id INTEGER PRIMARY KEY);\n');
    const db = openDatabaseFile(path.join(root, 'app.db'));
    try {
      await applyMigrations(db, { migrationsDir: migrations });
      writeFileSync(path.join(migrations, '002_next.sql'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY);\n');
      await expect(
        applyMigrations(db, {
          migrationsDir: migrations,
          backupBeforePending: async () => {
            throw new Error('disk full');
          },
        }),
      ).rejects.toThrow(/backup failed/i);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra'").get()).toBeUndefined();
      expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }]);
    } finally {
      db.close();
    }
  });

  it('stops startup when an applied migration file changes', async () => {
    const root = makeDir();
    const migrations = path.join(root, 'migrations');
    mkdirSync(migrations);
    const file = path.join(migrations, '001_init.sql');
    writeFileSync(file, 'CREATE TABLE marker (id INTEGER PRIMARY KEY);\n');
    const db = openDatabaseFile(path.join(root, 'app.db'));
    try {
      await applyMigrations(db, { migrationsDir: migrations });
      writeFileSync(file, 'CREATE TABLE marker (id INTEGER PRIMARY KEY);\nCREATE TABLE extra (id INTEGER PRIMARY KEY);\n');
      await expect(applyMigrations(db, { migrationsDir: migrations })).rejects.toThrow(/changed after it was applied/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rolls back a bad migration and names the file', async () => {
    const root = makeDir();
    const migrations = path.join(root, 'migrations');
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, '001_init.sql'), 'CREATE TABLE marker (id INTEGER PRIMARY KEY);\n');
    writeFileSync(path.join(migrations, '002_bad.sql'), 'CREATE TABLE (\n');
    const db = openDatabaseFile(path.join(root, 'app.db'));
    try {
      await expect(applyMigrations(db, { migrationsDir: migrations })).rejects.toThrow(/002_bad\.sql/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marker'").get()).toEqual({
        name: 'marker',
      });
      expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }]);
    } finally {
      db.close();
    }
  });

  it('rejects duplicate numbers, unnamed files, and a connection without foreign keys', async () => {
    const root = makeDir();
    const migrations = path.join(root, 'migrations');
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n');
    writeFileSync(path.join(migrations, '001_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);\n');
    const db = openDatabaseFile(path.join(root, 'app.db'));
    try {
      await expect(applyMigrations(db, { migrationsDir: migrations })).rejects.toThrow(/Duplicate migration number 001/);
    } finally {
      db.close();
    }

    const raw = new Database(path.join(root, 'raw.db'));
    raw.pragma('foreign_keys = OFF');
    try {
      await expect(applyMigrations(raw, { migrationsDir: migrations })).rejects.toThrow(/foreign_keys/);
    } finally {
      raw.close();
    }

    const loose = path.join(root, 'loose');
    mkdirSync(loose);
    writeFileSync(path.join(loose, 'notes.sql'), 'SELECT 1;\n');
    const other = openDatabaseFile(path.join(root, 'other.db'));
    try {
      await expect(applyMigrations(other, { migrationsDir: loose })).rejects.toThrow(/notes\.sql/);
    } finally {
      other.close();
    }
  });
});

describe('signup and shift constraints', () => {
  it('enforces capacity, individual signups, duplicates, anonymization, and history', async () => {
    const dataDir = path.join(makeDir(), 'data');
    const db = await openAppDatabase(loadConfig(devEnv({ DATA_DIR: dataDir })));
    try {
      const parents = insertParents(db);
      expect(() =>
        db.prepare(`INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity) VALUES (?, 'Sorting', ?, ?, 0)`).run(
          parents.eventId,
          INSTANT,
          LATER,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare(`INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity) VALUES (?, 'Sorting', ?, ?, 1)`)
          .run(parents.eventId, LATER, INSTANT),
      ).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity) VALUES (?, 'Sorting', '2026-10-20T14:00:00Z', ?, 1)`,
          )
          .run(parents.eventId, LATER),
      ).toThrow(/CHECK/);

      insertSignup(db, parents.shiftId, { email: 'Ada@Example.invalid', emailNorm: 'ada@example.invalid' });
      expect(() =>
        insertSignup(db, parents.shiftId, { email: 'ada@example.invalid', emailNorm: 'ada@example.invalid' }),
      ).toThrow(/UNIQUE/);
      expect(() =>
        insertSignup(db, parents.shiftId, { name: 'fake person', email: 'ada@example.invalid', emailNorm: 'ada@example.invalid' }),
      ).toThrow(/UNIQUE/);
      insertSignup(db, parents.shiftId, { name: 'Other Person', email: 'ada@example.invalid', emailNorm: 'ada@example.invalid' });
      const otherShift = insertShift(db, parents.eventId);
      insertSignup(db, otherShift, { email: 'ada@example.invalid', emailNorm: 'ada@example.invalid' });
      insertSignup(db, parents.shiftId, {
        email: 'ada@example.invalid',
        emailNorm: 'ada@example.invalid',
        status: 'cancelled',
      });
      insertSignup(db, parents.shiftId, {
        email: 'ada@example.invalid',
        emailNorm: 'ada@example.invalid',
        status: 'cancelled',
      });

      expect(() =>
        insertSignup(db, parents.shiftId, { email: 'ben@example.invalid', emailNorm: 'ben@example.invalid', groupSize: 2 }),
      ).toThrow(/CHECK/);
      expect(() =>
        insertSignup(db, parents.shiftId, {
          email: 'min@example.invalid',
          emailNorm: 'min@example.invalid',
          isMinor: 1,
        }),
      ).toThrow(/CHECK/);
      insertSignup(db, parents.shiftId, {
        email: 'min@example.invalid',
        emailNorm: 'min@example.invalid',
        isMinor: 1,
        guardianName: 'Guardian Pat',
        guardianEmail: 'pat@example.invalid',
      });
      expect(() =>
        insertSignup(db, parents.shiftId, { email: 'Up@Example.invalid', emailNorm: 'Up@Example.invalid' }),
      ).toThrow(/CHECK/);

      insertAnonymized(db, parents.shiftId);
      insertAnonymized(db, parents.shiftId);
      expect(() =>
        db
          .prepare(
            `INSERT INTO signups (
               shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at, anonymized_at
             ) VALUES (?, 'Still Named', NULL, NULL, 0, 1, 'confirmed', 0, ?, ?, ?)`,
          )
          .run(parents.shiftId, INSTANT, INSTANT, INSTANT),
      ).toThrow(/CHECK/);

      expect(() => db.prepare('DELETE FROM shifts WHERE id = ?').run(parents.shiftId)).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare('INSERT INTO signups (shift_id, name, email, email_norm, group_size, status, created_at, updated_at) VALUES (999999, ?, ?, ?, 1, ?, ?, ?)').run(
        'Nope',
        'nope@example.invalid',
        'nope@example.invalid',
        'confirmed',
        INSTANT,
        INSTANT,
      )).toThrow(/FOREIGN KEY/);

      db.prepare(
        `INSERT INTO shifts (
           event_id, template_id, occurrence_date, template_revision, role, starts_at_utc, ends_at_utc, capacity, cancelled
         ) VALUES (?, ?, '2026-10-27', 1, 'Sorting', ?, ?, 3, 1)`,
      ).run(parents.eventId, parents.templateId, INSTANT, LATER);
      expect(() =>
        db
          .prepare(
            `INSERT INTO shifts (
               event_id, template_id, occurrence_date, template_revision, role, starts_at_utc, ends_at_utc, capacity, cancelled
             ) VALUES (?, ?, '2026-10-27', 1, 'Sorting', ?, ?, 3, 0)`,
          )
          .run(parents.eventId, parents.templateId, INSTANT, LATER),
      ).toThrow(/UNIQUE/);

      const coordinator = db
        .prepare(`INSERT INTO coordinators (email, name, role, created_at) VALUES ('ada@example.invalid', 'Ada', 'admin', ?)`)
        .run(INSTANT);
      db.prepare(`INSERT INTO audit (coordinator_id, action, detail_json, at) VALUES (?, 'test', '{}', ?)`).run(
        coordinator.lastInsertRowid,
        INSTANT,
      );
      expect(() => db.prepare('DELETE FROM coordinators WHERE id = ?').run(coordinator.lastInsertRowid)).toThrow(
        /FOREIGN KEY/,
      );
      expect(() => db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('bad', '{', ?)`).run(INSTANT)).toThrow(
        /CHECK/,
      );
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('good', '{}', ?)`).run(INSTANT);

      const realSql = readFileSync(path.join(defaultMigrationsDir(), '001_init.sql'), 'utf8');
      expect(realSql).toContain('TODO(D2)');
      expect(realSql).not.toMatch(/ON DELETE CASCADE/i);
    } finally {
      db.close();
    }
  });
});

function insertParents(db: Database.Database): { eventId: number; templateId: number; shiftId: number } {
  const event = db
    .prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly-pantry', 'Weekly pantry', '', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    )
    .run(INSTANT);
  const template = db
    .prepare(
      `INSERT INTO shift_templates (
         event_id, role, weekday, start_local, end_local, capacity, starts_on, active, revision
       ) VALUES (?, 'Sorting', 2, '09:00', '12:00', 4, '2026-10-13', 1, 1)`,
    )
    .run(event.lastInsertRowid);
  const shiftId = insertShift(db, Number(event.lastInsertRowid));
  return {
    eventId: Number(event.lastInsertRowid),
    templateId: Number(template.lastInsertRowid),
    shiftId,
  };
}

function insertShift(db: Database.Database, eventId: number): number {
  const shift = db
    .prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes)
       VALUES (?, 'Sorting', ?, ?, 3, '')`,
    )
    .run(eventId, INSTANT, LATER);
  return Number(shift.lastInsertRowid);
}

function insertSignup(
  db: Database.Database,
  shiftId: number,
  options: {
    name?: string;
    email: string;
    emailNorm: string;
    status?: string;
    groupSize?: number;
    isMinor?: number;
    guardianName?: string | null;
    guardianEmail?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, guardian_name, guardian_email, group_size,
       status, reminders_off, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    shiftId,
    options.name ?? 'Fake Person',
    options.email,
    options.emailNorm,
    options.isMinor ?? 0,
    options.guardianName ?? null,
    options.guardianEmail ?? null,
    options.groupSize ?? 1,
    options.status ?? 'confirmed',
    INSTANT,
    INSTANT,
  );
}

function insertAnonymized(db: Database.Database, shiftId: number): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email, group_size,
       notes, status, manage_token_hash, token_expires_at, reminders_off, attended, created_at, updated_at, anonymized_at
     ) VALUES (?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 1, NULL, 'confirmed', NULL, NULL, 0, NULL, ?, ?, ?)`,
  ).run(shiftId, INSTANT, INSTANT, INSTANT);
}
