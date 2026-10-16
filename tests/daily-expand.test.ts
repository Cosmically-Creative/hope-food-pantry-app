import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { runDueTemplateExpansion, startDailyExpansionRunner } from '../src/jobs/daily-expand.js';
import { formatUtc } from '../src/time.js';
import { devEnv } from './env.js';

const CHICAGO = 'America/Chicago';
const HONOLULU = 'Pacific/Honolulu';
const BEFORE = '2026-01-15T06:30:00.000Z';
const AT_ONE = '2026-01-15T07:00:00.000Z';
const NEXT_WEEK = '2026-01-22T07:00:00.000Z';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('daily weekly refill', () => {
  it('waits for 1:00 in that event time zone and does not refill a zone that is still earlier', async () => {
    const db = await openDb();
    const chicago = insertEvent(db, 'chicago', CHICAGO);
    const honolulu = insertEvent(db, 'honolulu', HONOLULU);
    insertTemplate(db, chicago, 4, '2026-01-15');
    insertTemplate(db, honolulu, 3, '2026-01-14');
    const ended = insertEvent(db, 'ended', CHICAGO);
    insertTemplate(db, ended, 4, '2026-01-15', 0);

    expect(runDueTemplateExpansion(db, BEFORE)).toEqual({ zones: [HONOLULU], created: 9, skipped: [] });
    expect(shiftCount(db, chicago)).toBe(0);
    expect(shiftCount(db, honolulu)).toBe(9);
    expect(shiftCount(db, ended)).toBe(0);
    expect(marks(db)).toEqual([{ scope: HONOLULU, local_date: '2026-01-14' }]);

    expect(runDueTemplateExpansion(db, AT_ONE).zones).toEqual([CHICAGO]);
    expect(shiftCount(db, chicago)).toBe(9);
    expect(shiftCount(db, honolulu)).toBe(9);
    expect(shiftCount(db, ended)).toBe(0);
    expect(runDueTemplateExpansion(db, AT_ONE)).toEqual({ zones: [], created: 0, skipped: [] });
    expect(marks(db)).toEqual([
      { scope: CHICAGO, local_date: '2026-01-15' },
      { scope: HONOLULU, local_date: '2026-01-14' },
    ]);
  });

  it('adds the next week after the window moves, and leaves a cancelled date alone', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'chicago', CHICAGO);
    const templateId = insertTemplate(db, eventId, 4, '2026-01-15');
    db.prepare(
      `INSERT INTO shifts (
         event_id, template_id, occurrence_date, template_revision, role,
         starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
       ) VALUES (?, ?, '2026-01-15', 1, 'Kept', '2026-01-15T15:00:00.000Z', '2026-01-15T18:00:00.000Z', 2, '', 1, 1, 1)`,
    ).run(eventId, templateId);

    runDueTemplateExpansion(db, AT_ONE);
    const kept = db.prepare(`SELECT role AS role, cancelled AS cancelled FROM shifts WHERE occurrence_date = '2026-01-15'`).get();
    expect(kept).toEqual({ role: 'Kept', cancelled: 1 });
    expect(lastDate(db, eventId)).toBe('2026-03-12');

    runDueTemplateExpansion(db, NEXT_WEEK);
    expect(lastDate(db, eventId)).toBe('2026-03-19');
    expect(shiftCount(db, eventId)).toBe(10);
    expect(db.prepare(`SELECT detail_json AS detail_json FROM audit`).all().map((row) => (row as { detail_json: string }).detail_json).join(' ')).not.toContain('@');
  });

  it('runs once when 1:00 happens twice, and still runs when 1:00 does not exist', async () => {
    const repeated = await openDb();
    const chicago = insertEvent(repeated, 'chicago', CHICAGO);
    insertTemplate(repeated, chicago, 0, '2026-11-01');
    const firstHour = localUtc(CHICAGO, '2026-11-01', 1, 0, 'earlier');
    const secondHour = localUtc(CHICAGO, '2026-11-01', 1, 30, 'later');
    const before = localUtc(CHICAGO, '2026-11-01', 0, 30, 'reject');
    expect(runDueTemplateExpansion(repeated, before).zones).toEqual([]);
    const first = runDueTemplateExpansion(repeated, firstHour);
    expect(first.created).toBeGreaterThan(0);
    expect(runDueTemplateExpansion(repeated, secondHour)).toEqual({ zones: [], created: 0, skipped: [] });
    expect(marks(repeated)).toEqual([{ scope: CHICAGO, local_date: '2026-11-01' }]);

    const gap = await openDb();
    const troll = insertEvent(gap, 'troll', 'Antarctica/Troll');
    insertTemplate(gap, troll, 0, '2026-03-29');
    expect(runDueTemplateExpansion(gap, '2026-03-29T00:30:00.000Z').zones).toEqual([]);
    expect(runDueTemplateExpansion(gap, '2026-03-29T01:00:00.000Z').zones).toEqual(['Antarctica/Troll']);
    expect(shiftCount(gap, troll)).toBeGreaterThan(0);
    expect(runDueTemplateExpansion(gap, '2026-03-29T02:00:00.000Z')).toEqual({ zones: [], created: 0, skipped: [] });
  });

  it('skips a time zone it cannot read and still fills the others', async () => {
    const db = await openDb();
    const broken = insertEvent(db, 'broken', 'Not/AZone');
    insertTemplate(db, broken, 4, '2026-01-15');
    const chicago = insertEvent(db, 'chicago', CHICAGO);
    insertTemplate(db, chicago, 4, '2026-01-15');
    const errors: string[] = [];
    const write = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      expect(runDueTemplateExpansion(db, AT_ONE).zones).toEqual([CHICAGO]);
    } finally {
      console.error = write;
    }
    expect(shiftCount(db, chicago)).toBe(9);
    expect(shiftCount(db, broken)).toBe(0);
    expect(marks(db).map((row) => row.scope)).toEqual([CHICAGO]);
    expect(errors.join(' ')).toContain('Not/AZone');
    expect(errors.join(' ')).not.toContain('@');
  });

  it('fills due zones on the first check', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'chicago', CHICAGO);
    insertTemplate(db, eventId, 4, '2026-01-15');
    const runner = startDailyExpansionRunner(db, () => AT_ONE);
    expect(shiftCount(db, eventId)).toBe(9);
    runner.stop();
    expect(shiftCount(db, eventId)).toBe(9);
  });
});

function localUtc(zone: string, date: string, hour: number, minute: number, disambiguation: 'earlier' | 'later' | 'reject'): string {
  const [year, month, day] = date.split('-').map(Number);
  const zoned = Temporal.ZonedDateTime.from(
    { timeZone: zone, year, month, day, hour, minute, second: 0, millisecond: 0 },
    { disambiguation },
  );
  return formatUtc(zoned.toInstant());
}

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-refill-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return db;
}

function insertEvent(db: Awaited<ReturnType<typeof openDb>>, slug: string, tz: string): number {
  return Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', ?, 1, ?)`,
    ).run(slug, slug, tz, AT_ONE).lastInsertRowid,
  );
}

function insertTemplate(db: Awaited<ReturnType<typeof openDb>>, eventId: number, weekday: number, startsOn: string, active = 1): number {
  return Number(
    db.prepare(
      `INSERT INTO shift_templates (
         event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision
       ) VALUES (?, 'Sorting', ?, '09:00', '12:00', 6, ?, NULL, ?, 1)`,
    ).run(eventId, weekday, startsOn, active).lastInsertRowid,
  );
}

function shiftCount(db: Awaited<ReturnType<typeof openDb>>, eventId: number): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE event_id = ?').get(eventId) as { n: number }).n);
}

function lastDate(db: Awaited<ReturnType<typeof openDb>>, eventId: number): string {
  return (db.prepare('SELECT MAX(occurrence_date) AS d FROM shifts WHERE event_id = ?').get(eventId) as { d: string }).d;
}

function marks(db: Awaited<ReturnType<typeof openDb>>): Array<{ scope: string; local_date: string }> {
  return db.prepare('SELECT scope AS scope, local_date AS local_date FROM job_runs ORDER BY scope, local_date').all() as Array<{
    scope: string;
    local_date: string;
  }>;
}
