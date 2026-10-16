import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { describeBackup, runDueBackup, startBackupRunner } from '../src/jobs/backup.js';
import { formatUtc } from '../src/time.js';
import { devEnv } from './env.js';

const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('daily database backup', () => {
  it('saves one consistent copy after 2:30 and does not rewrite it later the same day', async () => {
    const { db, backups } = await openDb();
    const at = localUtc('2026-06-15', 2, 30);
    const before = localUtc('2026-06-15', 2, 0);
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('probe', '"first"', ?)`).run(at);

    expect((await runDueBackup(db, backups, before)).ran).toBe(false);
    expect(existsSync(path.join(backups, 'daily-2026-06-15.db'))).toBe(false);

    const saved = await runDueBackup(db, backups, at);
    expect(saved).toMatchObject({ ran: true, date: '2026-06-15', weekly: false, prunedDaily: 0, prunedWeekly: 0 });
    const copy = new Database(path.join(backups, 'daily-2026-06-15.db'), { readonly: true, fileMustExist: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.prepare(`SELECT value_json FROM settings WHERE key = 'probe'`).get()).toEqual({ value_json: '"first"' });
    } finally {
      copy.close();
    }
    expect(readdirSync(backups).filter((name) => name.includes('wal') || name.includes('shm') || name.endsWith('.partial'))).toEqual([]);
    expect(existsSync(path.join(backups, 'weekly-2026-06-15.db'))).toBe(false);

    db.prepare(`UPDATE settings SET value_json = '"later"' WHERE key = 'probe'`).run();
    expect((await runDueBackup(db, backups, localUtc('2026-06-15', 3, 0))).ran).toBe(false);
    const again = new Database(path.join(backups, 'daily-2026-06-15.db'), { readonly: true, fileMustExist: true });
    try {
      expect(again.prepare(`SELECT value_json FROM settings WHERE key = 'probe'`).get()).toEqual({ value_json: '"first"' });
    } finally {
      again.close();
    }
    expect(db.prepare(`SELECT detail_json FROM audit WHERE action = 'backup.save'`).get()).toEqual({
      detail_json: '{"prunedDaily":0,"prunedWeekly":0}',
    });
    expect(JSON.stringify(db.prepare('SELECT detail_json FROM audit').all())).not.toContain('@');
  });

  it('keeps 14 daily copies, 8 Sunday copies, and files that are not snapshots', async () => {
    const { db, backups } = await openDb();
    mkdirSync(backups, { recursive: true });
    for (let day = 1; day <= 20; day += 1) {
      writeFileSync(path.join(backups, `daily-2026-05-${String(day).padStart(2, '0')}.db`), '');
    }
    for (let day = 1; day <= 10; day += 1) {
      writeFileSync(path.join(backups, `weekly-2026-01-${String(day).padStart(2, '0')}.db`), '');
    }
    writeFileSync(path.join(backups, 'pre-migrate-20260601T000000000Z.db'), 'keep');
    writeFileSync(path.join(backups, 'notes.txt'), 'keep');

    const sunday = localUtc('2026-06-14', 2, 30);
    const saved = await runDueBackup(db, backups, sunday);
    expect(saved).toMatchObject({ ran: true, date: '2026-06-14', weekly: true, prunedDaily: 7, prunedWeekly: 3 });
    const names = readdirSync(backups).sort();
    expect(names).toContain('pre-migrate-20260601T000000000Z.db');
    expect(names).toContain('notes.txt');
    expect(names).toContain('daily-2026-06-14.db');
    expect(names).toContain('weekly-2026-06-14.db');
    expect(names).not.toContain('daily-2026-05-01.db');
    expect(names).not.toContain('daily-2026-05-07.db');
    expect(names).toContain('daily-2026-05-08.db');
    expect(names).not.toContain('weekly-2026-01-01.db');
    expect(names).toContain('weekly-2026-01-04.db');
    expect(names.filter((name) => name.includes('wal') || name.includes('shm') || name.endsWith('.partial'))).toEqual([]);
    const weekly = new Database(path.join(backups, 'weekly-2026-06-14.db'), { readonly: true, fileMustExist: true });
    try {
      expect(weekly.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      weekly.close();
    }
  });

  it('leaves older copies in place when the new backup fails', async () => {
    const { db, backups } = await openDb();
    mkdirSync(backups, { recursive: true });
    writeFileSync(path.join(backups, 'daily-2026-06-01.db'), 'older');
    writeFileSync(path.join(backups, 'pre-migrate-20260601T000000000Z.db'), 'keep');
    const errors: string[] = [];
    const write = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    let result: Awaited<ReturnType<typeof runDueBackup>>;
    try {
      result = await runDueBackup(db, backups, localUtc('2026-06-15', 2, 30), async () => {
        throw new Error('disk full');
      });
    } finally {
      console.error = write;
    }
    expect(result.ran).toBe(false);
    expect(readdirSync(backups).sort()).toEqual(['daily-2026-06-01.db', 'pre-migrate-20260601T000000000Z.db']);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE job = 'backup'`).get()).toEqual({ n: 0 });
    expect(errors.join(' ')).toContain('disk full');
    expect(errors.join(' ')).not.toContain('@');
  });

  it('waits through the missing 2:30 and runs once when the hour repeats its earlier neighbor', async () => {
    const spring = await openDb();
    expect((await runDueBackup(spring.db, spring.backups, localUtc('2026-03-08', 1, 30, 'reject'))).ran).toBe(false);
    expect((await runDueBackup(spring.db, spring.backups, localUtc('2026-03-08', 3, 0, 'reject'))).ran).toBe(true);
    expect((await runDueBackup(spring.db, spring.backups, localUtc('2026-03-08', 3, 30, 'reject'))).ran).toBe(false);

    const fall = await openDb();
    const duringRepeat = localUtc('2026-11-01', 1, 30, 'later');
    const atHalf = localUtc('2026-11-01', 2, 30, 'reject');
    expect((await runDueBackup(fall.db, fall.backups, duringRepeat)).ran).toBe(false);
    expect((await runDueBackup(fall.db, fall.backups, atHalf)).ran).toBe(true);
    expect((await runDueBackup(fall.db, fall.backups, localUtc('2026-11-01', 2, 45, 'reject'))).ran).toBe(false);
    expect(fall.db.prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE job = 'backup'`).get()).toEqual({ n: 1 });
  });

  it('describes a missing, current, or old backup without naming a file path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hope-backup-status-'));
    dirs.push(root);
    const early = localUtc('2026-06-15', 2, 0);
    const due = localUtc('2026-06-15', 2, 30);
    expect(describeBackup(root, early)).toEqual({
      state: 'waiting',
      text: 'No database backup has been saved yet.',
    });
    expect(describeBackup(root, due)).toEqual({
      state: 'behind',
      text: 'No database backup has been saved yet.',
    });
    writeFileSync(path.join(root, 'daily-2026-06-14.db'), '');
    expect(describeBackup(root, early).text).toBe('Database backup saved June 14, 2026.');
    expect(describeBackup(root, due)).toEqual({
      state: 'behind',
      text: 'Database backup is behind. The newest saved copy is June 14, 2026.',
    });
    writeFileSync(path.join(root, 'daily-2026-06-15.db'), '');
    expect(describeBackup(root, due)).toEqual({
      state: 'saved',
      text: 'Database backup saved June 15, 2026.',
    });
    expect(JSON.stringify(describeBackup(root, due))).not.toContain('/');
  });

  it('saves the backup on the first check after 2:30', async () => {
    const { db, backups } = await openDb();
    const runner = startBackupRunner(db, backups, () => localUtc('2026-06-15', 2, 30));
    const file = path.join(backups, 'daily-2026-06-15.db');
    for (let attempt = 0; attempt < 50 && !existsSync(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    runner.stop();
    expect(existsSync(file)).toBe(true);
  });
});

function localUtc(date: string, hour: number, minute: number, disambiguation: 'earlier' | 'later' | 'reject' = 'reject'): string {
  const [year, month, day] = date.split('-').map(Number);
  const zoned = Temporal.ZonedDateTime.from(
    { timeZone: 'America/Chicago', year, month, day, hour, minute, second: 0, millisecond: 0 },
    { disambiguation },
  );
  return formatUtc(zoned.toInstant());
}

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-backup-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  const backups = path.join(root, 'data', 'backups');
  return { db, backups };
}
