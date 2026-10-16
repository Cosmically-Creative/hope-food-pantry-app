import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { expandTemplates } from '../src/recurrence.js';
import { formatInstantInZone } from '../src/time.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const ZONE = 'America/Chicago';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('weekly template expansion', () => {
  it('adds the next eight weeks and leaves an existing occurrence alone', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'weekly', ZONE);
    const templateId = insertTemplate(db, eventId, { weekday: 3, startsOn: '2026-10-14' });
    db.prepare(
      `INSERT INTO shifts (
         event_id, template_id, occurrence_date, template_revision, role,
         starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
       ) VALUES (?, ?, '2026-10-14', 1, 'Kept', '2026-10-14T14:00:00.000Z', '2026-10-14T17:00:00.000Z', 2, 'leave me', 1, 1, 4)`,
    ).run(eventId, templateId);
    db.prepare(
      `INSERT INTO shifts (
         event_id, template_id, occurrence_date, template_revision, role,
         starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
       ) VALUES (?, NULL, NULL, NULL, 'One-off', '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', 3, '', 0, 0, 1)`,
    ).run(eventId);

    const first = expandTemplates(db, NOW);
    expect(first).toEqual({ created: 8, templates: 1, skipped: [] });
    const dates = db
      .prepare(
        `SELECT occurrence_date AS occurrence_date, role AS role, capacity AS capacity, cancelled AS cancelled, template_revision AS template_revision
         FROM shifts WHERE template_id = ? ORDER BY occurrence_date`,
      )
      .all(templateId) as Array<{ occurrence_date: string; role: string; capacity: number; cancelled: number; template_revision: number }>;
    expect(dates.map((row) => row.occurrence_date)).toEqual([
      '2026-10-14',
      '2026-10-21',
      '2026-10-28',
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
      '2026-12-02',
      '2026-12-09',
    ]);
    expect(dates[0]).toMatchObject({ role: 'Kept', capacity: 2, cancelled: 1, template_revision: 1 });
    expect(dates.slice(1).every((row) => row.role === 'Sorting' && row.capacity === 6 && row.cancelled === 0)).toBe(true);
    expect(db.prepare("SELECT role AS role FROM shifts WHERE template_id IS NULL").get()).toEqual({ role: 'One-off' });

    const again = expandTemplates(db, NOW, { coordinatorId: 4 });
    expect(again.created).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'template.expand'").get()).toEqual({ n: 1 });
    const audit = db.prepare("SELECT coordinator_id AS coordinator_id, detail_json AS detail_json FROM audit").get() as {
      coordinator_id: number | null;
      detail_json: string;
    };
    expect(audit.coordinator_id).toBeNull();
    expect(audit.detail_json).not.toContain('@');
    expect(JSON.parse(audit.detail_json)).toEqual({ templateId, created: 8 });
  });

  it('keeps 9:00 local on both sides of a daylight-saving change', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'spring', ZONE);
    insertTemplate(db, eventId, { weekday: 0, startsOn: '2026-03-01' });
    expandTemplates(db, '2026-03-01T17:00:00.000Z');
    expect(localClock(db, '2026-03-01')).toEqual({ time24: '09:00', abbreviation: 'CST' });
    expect(localClock(db, '2026-03-08')).toEqual({ time24: '09:00', abbreviation: 'CDT' });
    expect(localClock(db, '2026-03-15')).toEqual({ time24: '09:00', abbreviation: 'CDT' });

    const fall = insertEvent(db, 'fall', ZONE);
    insertTemplate(db, fall, { weekday: 0, startsOn: '2026-10-25' });
    expandTemplates(db, '2026-10-25T17:00:00.000Z', { eventId: fall });
    expect(localClock(db, '2026-10-25')).toEqual({ time24: '09:00', abbreviation: 'CDT' });
    expect(localClock(db, '2026-11-01')).toEqual({ time24: '09:00', abbreviation: 'CST' });
  });

  it('skips a local time that does not exist or happens twice', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'gap', ZONE);
    insertTemplate(db, eventId, { weekday: 0, startsOn: '2026-03-01', start: '02:30', end: '04:00' });
    const gap = expandTemplates(db, '2026-03-01T17:00:00.000Z');
    expect(gap.created).toBeGreaterThan(0);
    expect(gap.skipped.some((message) => message.includes('2026-03-08') && message.includes('does not exist'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE occurrence_date = '2026-03-08'").get()).toEqual({ n: 0 });
    expect(localClock(db, '2026-03-01').time24).toBe('02:30');
    expect(localClock(db, '2026-03-15').time24).toBe('02:30');

    const overlapEvent = insertEvent(db, 'overlap', ZONE);
    insertTemplate(db, overlapEvent, { weekday: 0, startsOn: '2026-10-25', start: '01:30', end: '03:30' });
    const overlap = expandTemplates(db, '2026-10-25T17:00:00.000Z', { eventId: overlapEvent });
    expect(overlap.skipped.some((message) => message.includes('2026-11-01') && message.includes('happens twice'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE event_id = ? AND occurrence_date = '2026-11-01'").get(overlapEvent)).toEqual({ n: 0 });
    expect(localClock(db, '2026-10-25', overlapEvent).time24).toBe('01:30');
  });

  it('respects the template dates and does not fill another event', async () => {
    const db = await openDb();
    const limited = insertEvent(db, 'limited', ZONE);
    insertTemplate(db, limited, { weekday: 3, startsOn: '2026-11-04', endsOn: '2026-11-18' });
    insertTemplate(db, limited, { weekday: 3, startsOn: '2026-10-14', active: 0 });
    const other = insertEvent(db, 'other', ZONE);
    insertTemplate(db, other, { weekday: 3, startsOn: '2026-10-14' });

    const result = expandTemplates(db, NOW, { eventId: limited });
    expect(result.templates).toBe(1);
    expect(
      db.prepare('SELECT occurrence_date AS occurrence_date FROM shifts WHERE event_id = ? ORDER BY occurrence_date').all(limited),
    ).toEqual([{ occurrence_date: '2026-11-04' }, { occurrence_date: '2026-11-11' }, { occurrence_date: '2026-11-18' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE event_id = ?').get(other)).toEqual({ n: 0 });
  });
});

describe('add weekly shifts', () => {
  it('adds from the event page once and refuses a form that is out of date', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db, 'weekly-pantry', ZONE);
    insertTemplate(db, eventId, { weekday: 3, startsOn: '2026-10-14' });
    const empty = insertEvent(db, 'plain', ZONE);
    const cookie = await signIn(app, db);

    const missing = await postGenerate(app, eventId, cookie, { csrf: 'wrong' });
    expect(missing.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(0);

    const added = await postGenerate(app, eventId, cookie);
    expect(added.status).toBe(303);
    expect(added.headers.get('location')).toBe(`/admin/events/${eventId}?notice=generated`);
    const page = await app.request(added.headers.get('location') ?? '', { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Weekly shifts for the next eight weeks are on the schedule.');
    expect(html).toContain('Add weekly shifts');
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(9);

    const repeat = await postGenerate(app, eventId, cookie);
    expect(repeat.headers.get('location')).toBe(`/admin/events/${eventId}?notice=generated`);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(9);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'template.expand'")).toBe(1);

    const none = await postGenerate(app, empty, cookie);
    expect(none.headers.get('location')).toBe(`/admin/events/${empty}?notice=no-template`);
  });
});

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-recur-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return db;
}

async function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-recur-http-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  bootstrapAdmin(db, config.bootstrapAdminEmail, NOW);
  const app = createApp(config, db, {
    now: NOW,
    clientIp: () => '203.0.113.10',
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db };
}

function insertEvent(db: Awaited<ReturnType<typeof openDb>>, slug: string, tz: string): number {
  const saved = db
    .prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', ?, 1, ?)`,
    )
    .run(slug, slug, tz, NOW);
  return Number(saved.lastInsertRowid);
}

function insertTemplate(
  db: Awaited<ReturnType<typeof openDb>>,
  eventId: number,
  options: { weekday: number; startsOn: string; endsOn?: string; start?: string; end?: string; active?: number },
): number {
  const saved = db
    .prepare(
      `INSERT INTO shift_templates (
         event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision
       ) VALUES (?, 'Sorting', ?, ?, ?, 6, ?, ?, ?, 1)`,
    )
    .run(
      eventId,
      options.weekday,
      options.start ?? '09:00',
      options.end ?? '12:00',
      options.startsOn,
      options.endsOn ?? null,
      options.active ?? 1,
    );
  return Number(saved.lastInsertRowid);
}

function localClock(db: Awaited<ReturnType<typeof openDb>>, date: string, eventId?: number) {
  const row = db
    .prepare(
      `SELECT starts_at_utc AS starts_at_utc FROM shifts
       WHERE occurrence_date = ?${eventId === undefined ? '' : ' AND event_id = ?'}`,
    )
    .get(...(eventId === undefined ? [date] : [date, eventId])) as { starts_at_utc: string };
  const clock = formatInstantInZone(row.starts_at_utc, ZONE);
  return { time24: clock.time24, abbreviation: clock.abbreviation };
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>['app'], db: Awaited<ReturnType<typeof openDb>>) {
  await app.request('/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'coordinator@example.invalid', company_website: '', 'cf-turnstile-response': 'token' }),
  });
  const queued = db.prepare("SELECT body_text AS body_text FROM outbox WHERE kind = 'magic_link'").get() as { body_text: string };
  const token = /\/login\/link\/([A-Za-z0-9_-]+)/.exec(queued.body_text)?.[1] ?? '';
  const page = await app.request(`/login/link/${token}`);
  const proof = /name="proof"[^>]*value="([^"]*)"/.exec(await page.text())?.[1] ?? '';
  const signedIn = await app.request(`/login/link/${token}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ proof }),
  });
  const cookie = /hope_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return `hope_session=${cookie}`;
}

async function postGenerate(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  eventId: number,
  cookie: string,
  options?: { csrf?: string },
) {
  const current = await app.request(`/admin/events/${eventId}`, { headers: { cookie } });
  const csrf = options?.csrf ?? (/name="csrf"[^>]*value="([^"]*)"/.exec(await current.text())?.[1] ?? '');
  return app.request(`/admin/events/${eventId}/generate`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf }),
  });
}

function count(db: Awaited<ReturnType<typeof openDb>>, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}
