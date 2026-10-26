import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { csvCell, exportDateRange, exportEventRoster, exportShiftRoster } from '../src/export.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('roster export', () => {
  it('keeps formula-looking cells as text and quotes commas', () => {
    expect(csvCell('=cmd')).toBe("'=cmd");
    expect(csvCell('\t+1')).toBe("'\t+1");
    expect(csvCell(' -Ada')).toBe("' -Ada");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('Ada, "Pat"')).toBe('"Ada, ""Pat"""');
    expect(csvCell('Ada')).toBe('Ada');
  });

  it('exports one shift, including a cancelled person, and leaves another shift out', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'weekly', 'Weekly pantry');
    const shiftId = insertShift(db, eventId, '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z');
    const other = insertShift(db, eventId, '2026-10-17T14:00:00.000Z', '2026-10-17T17:00:00.000Z');
    insertSignup(db, shiftId, { name: '=Ada', email: 'ada@example.invalid', notes: 'Blue, shirt' });
    insertSignup(db, shiftId, { name: 'Ben', email: 'ben@example.invalid', status: 'cancelled' });
    insertSignup(db, shiftId, { name: null, email: null, anonymized: true });
    insertSignup(db, other, { name: 'Cam', email: 'cam@example.invalid' });

    const exported = exportShiftRoster(db, shiftId);
    expect(exported).not.toBeNull();
    const text = exported?.csv ?? '';
    expect(text.startsWith('\uFEFFDate,Start,End,Time zone,Role,')).toBe(true);
    expect(text).toContain('\r\n');
    expect(text).toContain("'=Ada");
    expect(text).toContain('"Blue, shirt"');
    expect(text).toContain('ada@example.invalid');
    expect(text).toContain('Cancelled');
    expect(text).not.toContain('Attended');
    expect(text).toContain('2026-10-15');
    expect(text).toContain('America/Chicago (CDT)');
    expect(text).not.toContain('cam@example.invalid');
    expect(text).not.toContain('Cam');
    const anonymized = text.split('\r\n').find((line) => line.endsWith(',Confirmed') && !line.includes('@'));
    expect(anonymized).toBeTruthy();
  });

  it('uses the event local date for a range and refuses a backwards range', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'weekly', 'Weekly pantry');
    const late = insertShift(db, eventId, '2026-10-15T04:30:00.000Z', '2026-10-15T06:00:00.000Z');
    const morning = insertShift(db, eventId, '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z');
    insertSignup(db, late, { name: 'Late', email: 'late@example.invalid' });
    insertSignup(db, morning, { name: 'Morning', email: 'morning@example.invalid' });
    const hidden = insertEvent(db, 'hidden', 'Hidden drive', 0);
    const hiddenShift = insertShift(db, hidden, '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z');
    insertSignup(db, hiddenShift, { name: 'Hidden', email: 'hidden@example.invalid' });

    const range = exportDateRange(db, '2026-10-15', '2026-10-15');
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.export.rows).toBe(2);
    expect(range.export.csv).toContain('morning@example.invalid');
    expect(range.export.csv).toContain('hidden@example.invalid');
    expect(range.export.csv).not.toContain('late@example.invalid');

    const event = exportEventRoster(db, eventId);
    expect(event?.rows).toBe(2);
    expect(event?.csv).not.toContain('hidden@example.invalid');
    expect(exportDateRange(db, '2026-10-16', '2026-10-15')).toEqual({ ok: false, error: 'The end date is before the start date.' });
    expect(exportDateRange(db, '2026-02-31', '2026-03-01')).toEqual({ ok: false, error: 'Use real dates.' });
    expect(exportDateRange(db, '2024-01-01', '2026-01-02').ok).toBe(false);
  });

  it('downloads through the coordinator session and records the count, not the people', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db, 'weekly', 'Weekly pantry');
    const shiftId = insertShift(db, eventId, '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z');
    insertSignup(db, shiftId, { name: 'Ada', email: 'ada@example.invalid', phone: '+1 712' });
    const cookie = await signIn(app, db);

    const loggedOut = await app.request(`/admin/shifts/${shiftId}/export`, { method: 'POST' });
    expect(loggedOut.status).toBe(303);
    expect(await loggedOut.text()).not.toContain('ada@example.invalid');

    const stale = await postExport(app, cookie, `/admin/shifts/${shiftId}/export`, 'nope');
    expect(stale.status).toBe(403);
    expect(await stale.text()).not.toContain('ada@example.invalid');

    const file = await postExport(app, cookie, `/admin/shifts/${shiftId}/export`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/csv');
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="hope-shift-${shiftId}.csv"`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain("'+1 712");
    const audit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'roster.export'`).get() as { detail_json: string };
    expect(audit.detail_json).toBe(`{"shiftId":${shiftId},"rows":1}`);
    expect(audit.detail_json).not.toContain('@');

    const ranged = await postExport(app, cookie, '/admin/export', undefined, { from: '2026-10-15', to: '2026-10-15' });
    expect(ranged.headers.get('content-disposition')).toBe('attachment; filename="hope-roster-2026-10-15-to-2026-10-15.csv"');
    const backwards = await postExport(app, cookie, '/admin/export', undefined, { from: '2026-10-20', to: '2026-10-01' });
    expect(backwards.status).toBe(400);
    expect(await backwards.text()).toContain('The end date is before the start date.');
  });
});

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-export-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return db;
}

async function buildApp() {
  const db = await openDb();
  bootstrapAdmin(db, 'coordinator@example.invalid', NOW);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(rootOf(db), 'data') }));
  const app = createApp(config, db, {
    now: NOW,
    clientIp: () => '203.0.113.50',
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db };
}

function rootOf(db: { name: string }): string {
  return path.dirname(path.dirname(db.name));
}

function insertEvent(db: Awaited<ReturnType<typeof openDb>>, slug: string, title: string, published = 1): number {
  return Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', 'America/Chicago', ?, ?)`,
    ).run(slug, title, published, NOW).lastInsertRowid,
  );
}

function insertShift(db: Awaited<ReturnType<typeof openDb>>, eventId: number, start: string, end: string): number {
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', ?, ?, 4, '', 0)`,
    ).run(eventId, start, end).lastInsertRowid,
  );
}

function insertSignup(
  db: Awaited<ReturnType<typeof openDb>>,
  shiftId: number,
  options: {
    name: string | null;
    email: string | null;
    notes?: string | null;
    phone?: string | null;
    status?: string;
    anonymized?: boolean;
  },
): void {
  const anonymized = options.anonymized === true;
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email, group_size, notes,
       status, reminders_off, created_at, updated_at, anonymized_at
     ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 1, ?, ?, 0, ?, ?, ?)`,
  ).run(
    shiftId,
    anonymized ? null : options.name,
    anonymized ? null : options.email,
    anonymized ? null : options.email,
    anonymized ? null : options.phone ?? null,
    anonymized ? null : options.notes ?? null,
    options.status ?? 'confirmed',
    NOW,
    NOW,
    anonymized ? NOW : null,
  );
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>['app'], db: Awaited<ReturnType<typeof openDb>>) {
  await app.request('/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'coordinator@example.invalid', company_website: '', 'cf-turnstile-response': 'token' }),
  });
  const queued = db.prepare(`SELECT body_text AS body_text FROM outbox WHERE kind = 'magic_link'`).get() as { body_text: string };
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

async function postExport(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  pathName: string,
  csrf?: string,
  fields?: { from: string; to: string },
) {
  const current = await app.request(pathName.startsWith('/admin/export') ? '/admin' : pathName.replace(/\/export$/, ''), { headers: { cookie } });
  const token = csrf ?? (/name="csrf"[^>]*value="([^"]*)"/.exec(await current.text())?.[1] ?? '');
  const body = new URLSearchParams({ csrf: token, from: fields?.from ?? '', to: fields?.to ?? '' });
  return app.request(pathName, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });
}
