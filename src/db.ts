import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { nowUtc } from './time.js';

const MIGRATION_NAME = /^(\d{3,})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type ApplyMigrationsOptions = {
  migrationsDir: string;
  now?: string;
  backupBeforePending?: () => Promise<void>;
};

export function defaultMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
}

export function configureConnection(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

export function openDatabaseFile(file: string): Database.Database {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    throw new MigrationError(
      `Startup aborted. Could not create the data directory ${path.dirname(file)}. ${messageOf(err)}`,
    );
  }
  const db = new Database(file);
  configureConnection(db);
  return db;
}

export async function openAppDatabase(
  config: AppConfig,
  options?: { migrationsDir?: string },
): Promise<Database.Database> {
  const db = openDatabaseFile(config.databaseFile);
  try {
    await applyMigrations(db, {
      migrationsDir: options?.migrationsDir ?? defaultMigrationsDir(),
      backupBeforePending:
        config.nodeEnv === 'production' ? () => backupBeforeProductionMigration(db, config.dataDir) : undefined,
    });
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') {
      throw new MigrationError(`Startup aborted. Database integrity check failed: ${String(quick)}`);
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function backupDatabase(db: Database.Database, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await db.backup(destination);
    const check = new Database(destination);
    try {
      check.pragma('wal_checkpoint(TRUNCATE)');
      const mode = check.pragma('journal_mode = DELETE', { simple: true });
      if (mode !== 'delete') throw new Error(`journal mode stayed ${String(mode)}`);
      const result = check.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`integrity check returned ${String(result)}`);
    } finally {
      check.close();
    }
    await rm(`${destination}-wal`, { force: true });
    await rm(`${destination}-shm`, { force: true });
  } catch (err) {
    await rm(destination, { force: true });
    await rm(`${destination}-wal`, { force: true });
    await rm(`${destination}-shm`, { force: true });
    throw new Error(`Backup ${destination} failed. ${messageOf(err)}`);
  }
}

export async function applyMigrations(
  db: Database.Database,
  options: ApplyMigrationsOptions,
): Promise<{ applied: string[] }> {
  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }));
  if (foreignKeys !== 1) {
    throw new MigrationError('Startup aborted. foreign_keys must be ON before migrations run.');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const files = listMigrationFiles(options.migrationsDir);
  verifyAppliedChecksums(db, files, options.migrationsDir);
  const appliedNames = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((row) => row.name),
  );
  const pending = files.filter((file) => !appliedNames.has(file.name));
  // A brand-new database has nothing to preserve. Later production migrations
  // snapshot the existing file before any new SQL runs.
  if (pending.length > 0 && appliedNames.size > 0 && options.backupBeforePending) {
    try {
      await options.backupBeforePending();
    } catch (err) {
      throw new MigrationError(
        `Startup aborted. The database was not migrated because the pre-migration backup failed. ${messageOf(err)}`,
      );
    }
  }
  const applied: string[] = [];
  for (const file of pending) {
    const relaxForeignKeys = file.sql.split('\n').some((line) => line.trim() === '-- foreign-keys: off');
    const apply = db.transaction(() => {
      db.exec(file.sql);
      if (relaxForeignKeys) {
        const broken = db.pragma('foreign_key_check');
        if (Array.isArray(broken) && broken.length > 0) {
          throw new Error('foreign key check failed');
        }
      }
      db.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(
        file.name,
        file.checksum,
        options.now ?? nowUtc(),
      );
    });
    if (relaxForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      apply();
    } catch (err) {
      throw new MigrationError(`Startup aborted. Migration ${file.name} failed: ${messageOf(err)}`);
    } finally {
      if (relaxForeignKeys) db.pragma('foreign_keys = ON');
    }
    applied.push(file.name);
  }
  return { applied };
}

async function backupBeforeProductionMigration(db: Database.Database, dataDir: string): Promise<void> {
  const destination = path.join(dataDir, 'backups', `pre-migrate-${backupStamp()}.db`);
  await backupDatabase(db, destination);
}

function backupStamp(now = nowUtc()): string {
  return now.replace(/[-:]/g, '').replace('.', '');
}

type MigrationFile = { name: string; sql: string; checksum: string };

function listMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!existsSync(migrationsDir)) {
    throw new MigrationError(`Startup aborted. Migrations directory is missing: ${migrationsDir}`);
  }
  const names = readdirSync(migrationsDir).filter((name) => name !== '.gitkeep');
  const files: MigrationFile[] = [];
  const numbers = new Map<string, string>();
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      throw new MigrationError(
        `Startup aborted. ${name} is not a numbered migration. Use a name like 002_description.sql.`,
      );
    }
    const number = match[1];
    if (!number) throw new MigrationError(`Startup aborted. Could not read the migration number in ${name}.`);
    const previous = numbers.get(number);
    if (previous) {
      throw new MigrationError(`Startup aborted. Duplicate migration number ${number} on ${previous} and ${name}.`);
    }
    numbers.set(number, name);
    const full = path.join(migrationsDir, name);
    const bytes = readFileSync(full);
    const sql = bytes.toString('utf8');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/im.test(sql)) {
      throw new MigrationError(
        `Startup aborted. ${name} must not contain BEGIN, COMMIT, ROLLBACK, or PRAGMA. The runner handles those.`,
      );
    }
    files.push({
      name,
      sql,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  files.sort((a, b) => {
    const aNumber = Number(MIGRATION_NAME.exec(a.name)?.[1] ?? 0);
    const bNumber = Number(MIGRATION_NAME.exec(b.name)?.[1] ?? 0);
    return aNumber - bNumber || a.name.localeCompare(b.name);
  });
  return files;
}

function verifyAppliedChecksums(db: Database.Database, files: MigrationFile[], migrationsDir: string): void {
  const byName = new Map(files.map((file) => [file.name, file]));
  const applied = db.prepare('SELECT name, checksum FROM schema_migrations').all() as {
    name: string;
    checksum: string;
  }[];
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      throw new MigrationError(
        `Startup aborted. The database has applied ${row.name}, but that file is missing from ${migrationsDir}.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Startup aborted. ${row.name} changed after it was applied. Add a new numbered migration instead of editing an applied file.`,
      );
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
