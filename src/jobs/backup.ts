import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import Database from 'better-sqlite3';
import { writeAudit } from '../auth/audit.js';
import { backupDatabase } from '../db.js';
import { formatInstantInZone } from '../time.js';

/** Central Time. 2:30 is missing on the spring-forward morning, so the clock comparison is used. */
export const BACKUP_ZONE = 'America/Chicago';
export const BACKUP_LOCAL_TIME = '02:30';
export const DAILY_KEEP = 14;
export const WEEKLY_KEEP = 8;

export function backupDirectory(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

const JOB = 'backup';
const POLL_MS = 60 * 1000;
const SNAPSHOT = /^(daily|weekly)-(\d{4}-\d{2}-\d{2})\.db$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type BackupCopy = (db: Database.Database, destination: string) => Promise<void>;

export type BackupResult = {
  ran: boolean;
  date: string;
  weekly: boolean;
  prunedDaily: number;
  prunedWeekly: number;
};

export type BackupStatus = {
  state: 'saved' | 'waiting' | 'behind';
  text: string;
  /** True only when a daily copy exists for today's Central Time date. */
  savedToday: boolean;
};

/**
 * Saves one consistent database copy per Central Time date, after 2:30.
 * A failed attempt does not remove older copies and does not record the day,
 * so the next check can try again. Sunday's copy is also kept as a weekly file.
 */
export async function runDueBackup(
  db: Database.Database,
  backupsDir: string,
  now: string,
  copy: BackupCopy = backupDatabase,
): Promise<BackupResult> {
  const skipped: BackupResult = { ran: false, date: '', weekly: false, prunedDaily: 0, prunedWeekly: 0 };
  const clock = formatInstantInZone(now, BACKUP_ZONE);
  if (clock.time24 < BACKUP_LOCAL_TIME || alreadyRan(db, clock.date)) return skipped;
  const partial = path.join(backupsDir, `daily-${clock.date}.db.partial`);
  const daily = path.join(backupsDir, `daily-${clock.date}.db`);
  try {
    await copy(db, partial);
    await mkdir(backupsDir, { recursive: true });
    await rename(partial, daily);
    const weekly = clock.weekday === 0;
    if (weekly) await copySnapshot(daily, path.join(backupsDir, `weekly-${clock.date}.db`));
    const prunedDaily = pruneSnapshots(backupsDir, 'daily', DAILY_KEEP);
    const prunedWeekly = pruneSnapshots(backupsDir, 'weekly', WEEKLY_KEEP);
    markRan(db, clock.date, now);
    try {
      writeAudit(db, null, 'backup.save', { prunedDaily, prunedWeekly }, now);
    } catch {
      console.error('The database backup was saved, but the audit note was not recorded.');
    }
    return { ran: true, date: clock.date, weekly, prunedDaily, prunedWeekly };
  } catch (err) {
    await rm(partial, { force: true });
    console.error(err instanceof Error ? err.message : 'Database backup failed.');
    return skipped;
  }
}

/** Newest daily copy, and whether today's backup is still expected later. */
export function describeBackup(backupsDir: string, now: string): BackupStatus {
  const newest = newestSnapshot(backupsDir, 'daily');
  const clock = formatInstantInZone(now, BACKUP_ZONE);
  if (!newest) {
    const state = clock.time24 < BACKUP_LOCAL_TIME ? 'waiting' : 'behind';
    return { state, text: 'No database backup has been saved yet.', savedToday: false };
  }
  const label = prettyDate(newest);
  const savedToday = newest >= clock.date;
  const savedYesterday = newest >= previousDate(clock.date) && clock.time24 < BACKUP_LOCAL_TIME;
  if (savedToday || savedYesterday) return { state: 'saved', text: `Database backup saved ${label}.`, savedToday };
  return { state: 'behind', text: `Database backup is behind. The newest saved copy is ${label}.`, savedToday: false };
}

export function startBackupRunner(
  db: Database.Database,
  backupsDir: string,
  now: () => string,
): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    void (async () => {
      try {
        const result = await runDueBackup(db, backupsDir, now());
        if (result.ran) console.log(`Saved the database backup for ${result.date}.`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : 'Database backup failed.');
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(tick, POLL_MS);
  timer.unref();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function copySnapshot(source: string, destination: string): Promise<void> {
  const partial = `${destination}.partial`;
  try {
    await copyFile(source, partial);
    const check = new Database(partial, { readonly: true, fileMustExist: true });
    try {
      const result = check.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error('Sunday backup failed the integrity check.');
    } finally {
      check.close();
    }
    await rename(partial, destination);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

function pruneSnapshots(backupsDir: string, kind: 'daily' | 'weekly', keep: number): number {
  const matched = listSnapshots(backupsDir, kind);
  const extra = matched.slice(keep);
  for (const file of extra) unlinkSync(path.join(backupsDir, file.name));
  return extra.length;
}

function newestSnapshot(backupsDir: string, kind: 'daily' | 'weekly'): string | null {
  return listSnapshots(backupsDir, kind)[0]?.date ?? null;
}

function listSnapshots(backupsDir: string, kind: 'daily' | 'weekly'): { name: string; date: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(backupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .map((name) => {
      const match = SNAPSHOT.exec(name);
      if (!match || match[1] !== kind || !match[2]) return null;
      return { name, date: match[2] };
    })
    .filter((row): row is { name: string; date: string } => row !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function prettyDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

function previousDate(iso: string): string {
  return Temporal.PlainDate.from(iso).subtract({ days: 1 }).toString();
}

function alreadyRan(db: Database.Database, localDate: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM job_runs WHERE job = ? AND scope = ? AND local_date = ?').get(JOB, BACKUP_ZONE, localDate);
  return row !== undefined;
}

function markRan(db: Database.Database, localDate: string, now: string): void {
  db.prepare('INSERT INTO job_runs (job, scope, local_date, ran_at) VALUES (?, ?, ?, ?)').run(JOB, BACKUP_ZONE, localDate, now);
}
