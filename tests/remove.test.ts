import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteCancelledSignup, deleteEvent, deleteEndedTemplate, deleteFinishedShift } from '../src/admin/store.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { expandTemplates } from '../src/recurrence.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const PAST_END = '2026-10-14T17:00:00.000Z';
const FUTURE_START = '2026-10-21T14:00:00.000Z';
const FUTURE_END = '2026-10-21T17:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const ZONE = 'America/Chicago';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('removing finished records', () => {
  it('deletes a cancelled person and the mail tied to them', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const shiftId = insertShift(db, eventId, { cancelled: 1 });
    const cancelledId = insertSignup(db, shiftId, 'cancelled');
    const confirmedId = insertSignup(db, shiftId, 'confirmed');
    const outboxId = insertOutbox(db, cancelledId, shiftId);
    db.prepare(
      `INSERT INTO reminders_sent (signup_id, kind, shift_version, outbox_id, queued_at)
       VALUES (?, '48h', 1, ?, ?)`,
    ).run(cancelledId, outboxId, NOW);

    expect(deleteCancelledSignup(db, 1, confirmedId, NOW)).toEqual({ ok: false, error: 'Cancel this signup before removing it.' });
    expect(deleteCancelledSignup(db, 1, cancelledId, NOW)).toEqual({ ok: true, shiftId });
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups WHERE id = ?', cancelledId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups WHERE id = ?', confirmedId)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM reminders_sent')).toBe(0);
    const audit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'signup.delete'`).get() as { detail_json: string };
    expect(audit.detail_json).not.toContain('@');
  });

  it('deletes an empty finished shift and lets an active template add that date again', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const openId = insertShift(db, eventId, { start: FUTURE_START, end: FUTURE_END });
    expect(deleteFinishedShift(db, 1, openId, NOW).ok).toBe(false);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', openId)).toBe(1);

    const templateId = insertTemplate(db, eventId, 1);
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    const generated = db.prepare(`SELECT id AS id FROM shifts WHERE template_id = ? AND occurrence_date = '2026-10-21'`).get(templateId) as { id: number };
    db.prepare('UPDATE shifts SET cancelled = 1 WHERE id = ?').run(generated.id);
    expect(deleteFinishedShift(db, 1, generated.id, NOW)).toEqual({ ok: true, eventId });
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    expect(count(db, `SELECT COUNT(*) AS n FROM shifts WHERE template_id = ? AND occurrence_date = '2026-10-21'`, templateId)).toBe(1);

    const occupied = insertShift(db, eventId, { cancelled: 1 });
    insertSignup(db, occupied, 'cancelled');
    expect(deleteFinishedShift(db, 1, occupied, NOW)).toEqual({ ok: false, error: 'Remove everyone on this roster first.' });
  });

  it('removes an ended template and leaves its shifts in place', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const activeId = insertTemplate(db, eventId, 1);
    expect(deleteEndedTemplate(db, 1, eventId, activeId, NOW).ok).toBe(false);
    db.prepare('UPDATE shift_templates SET active = 0 WHERE id = ?').run(activeId);
    const shiftId = insertShift(db, eventId, { templateId: activeId, occurrence: '2026-10-14' });
    expect(deleteEndedTemplate(db, 1, eventId, activeId, NOW)).toEqual({ ok: true, eventId });
    expect(count(db, 'SELECT COUNT(*) AS n FROM shift_templates')).toBe(0);
    const shift = db.prepare('SELECT template_id, occurrence_date, template_revision FROM shifts WHERE id = ?').get(shiftId) as {
      template_id: number | null;
      occurrence_date: string | null;
      template_revision: number | null;
    };
    expect(shift).toEqual({ template_id: null, occurrence_date: null, template_revision: null });
    expect(count(db, `SELECT COUNT(*) AS n FROM audit WHERE action = 'template.delete'`)).toBe(1);
  });

  it('removes through the coordinator pages and refuses a stale form', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db);
    const shiftId = insertShift(db, eventId, { cancelled: 1, start: PAST_END, end: NOW });
    const signupId = insertSignup(db, shiftId, 'cancelled');
    const cookie = await signIn(app, db);

    const stale = await postRemove(app, cookie, `/admin/signups/${signupId}/remove`, 'nope');
    expect(stale.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(1);

    const removedPerson = await postRemove(app, cookie, `/admin/signups/${signupId}/remove`);
    expect(removedPerson.status).toBe(303);
    expect(removedPerson.headers.get('location')).toBe(`/admin/shifts/${shiftId}?notice=signup-removed`);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(0);

    const removedShift = await postRemove(app, cookie, `/admin/shifts/${shiftId}/remove`);
    expect(removedShift.headers.get('location')).toBe(`/admin/events/${eventId}?notice=shift-removed`);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(0);

    const templateId = insertTemplate(db, eventId, 0);
    const kept = insertShift(db, eventId, { templateId, occurrence: '2026-10-21', start: FUTURE_START, end: FUTURE_END });
    const removedTemplate = await postRemove(app, cookie, `/admin/events/${eventId}/templates/${templateId}/remove`);
    expect(removedTemplate.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-removed`);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shift_templates')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', kept)).toBe(1);
    const page = await app.request(`/admin/events/${eventId}?notice=template-removed`, { headers: { cookie } });
    expect(await page.text()).toContain('That weekly template is removed.');
  });

  it('deletes a hidden event together with its shifts, templates, and signups', async () => {
    const db = await openDb();
    const kept = insertEvent(db, { slug: 'kept', title: 'Kept drive', published: 0 });
    const keptShift = insertShift(db, kept, { start: FUTURE_START, end: FUTURE_END });
    const keptSignup = insertSignup(db, keptShift, 'confirmed', 'kept@example.invalid');
    const keptMail = insertOutbox(db, keptSignup, keptShift);
    db.prepare(
      `INSERT INTO reminders_sent (signup_id, kind, shift_version, outbox_id, queued_at)
       VALUES (?, '48h', 1, ?, ?)`,
    ).run(keptSignup, keptMail, NOW);
    const published = insertEvent(db, { slug: 'open-day', title: 'Open day', published: 1 });
    const templateId = insertTemplate(db, published, 1);
    const openShift = insertShift(db, published, { start: FUTURE_START, end: FUTURE_END, templateId, occurrence: '2026-10-21' });
    const signupId = insertSignup(db, openShift, 'confirmed', 'ada@example.invalid');
    const outboxId = insertOutbox(db, signupId, openShift);
    db.prepare(
      `INSERT INTO reminders_sent (signup_id, kind, shift_version, outbox_id, queued_at)
       VALUES (?, '48h', 1, ?, ?)`,
    ).run(signupId, outboxId, NOW);
    expect(deleteEvent(db, 1, published, NOW)).toEqual({ ok: true });
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', published)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE event_id = ?', published)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shift_templates WHERE id = ?', templateId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups WHERE id = ?', signupId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox WHERE id = ?', outboxId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM reminders_sent WHERE signup_id = ?', signupId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', kept)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', keptShift)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups WHERE id = ?', keptSignup)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox WHERE id = ?', keptMail)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM reminders_sent WHERE signup_id = ?', keptSignup)).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const audit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'event.delete'`).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toEqual({ eventId: published, shifts: 1, templates: 1, signups: 1 });
    expect(audit.detail_json).not.toContain('@');
  });

  it('removes an empty hidden event from the coordinator page', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db);
    const hidden = insertEvent(db, { slug: 'old-drive', title: 'Old drive', published: 0 });
    const cookie = await signIn(app, db);

    const asking = await app.request(`/admin/events/${eventId}/remove`, { headers: { cookie } });
    const askingPage = await asking.text();
    expect(askingPage).toContain('This deletes the event.');
    expect(askingPage).toContain('This event is on the public list. Removing it takes that listing away.');
    expect(askingPage).toContain('Remove this event</button>');

    const stale = await postRemove(app, cookie, `/admin/events/${hidden}/remove`, 'nope');
    expect(stale.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', hidden)).toBe(1);

    const removed = await postRemove(app, cookie, `/admin/events/${hidden}/remove`);
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/admin?notice=event-removed');
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', hidden)).toBe(0);
    const home = await app.request('/admin?notice=event-removed', { headers: { cookie } });
    expect(await home.text()).toContain('That event is removed.');
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', eventId)).toBe(1);
  });

  it('removes a public event and the shifts under it after one confirmation', async () => {
    const { app, db } = await buildApp();
    const kept = insertEvent(db, { slug: 'kept-drive', title: 'Kept drive', published: 1 });
    const keptShift = insertShift(db, kept);
    const eventId = insertEvent(db, { slug: 'old-drive-full', title: 'Old drive', published: 1 });
    const shiftId = insertShift(db, eventId, { start: FUTURE_START, end: FUTURE_END });
    insertTemplate(db, eventId, 1);
    const signupId = insertSignup(db, shiftId, 'confirmed', 'ada@example.invalid');
    const cookie = await signIn(app, db);

    const page = await app.request(`/admin/events/${eventId}/remove`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('This deletes the event, 1 shift, and 1 weekly template.');
    expect(html).toContain('The signup on those shifts is deleted too, including the name and email.');
    expect(html).toContain('This event is on the public list. Removing it takes that listing away.');
    expect(html).toContain('Remove this event</button>');

    const removed = await postRemove(app, cookie, `/admin/events/${eventId}/remove`);
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/admin?notice=event-removed');
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', eventId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', shiftId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups WHERE id = ?', signupId)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', kept)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', keptShift)).toBe(1);
  });

  it('removes selected finished shifts together and leaves the rest', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db, { published: 0, slug: 'batch', title: 'Batch' });
    const first = insertShift(db, eventId, { cancelled: 1 });
    const second = insertShift(db, eventId, { cancelled: 1 });
    const kept = insertShift(db, eventId, { start: FUTURE_START, end: FUTURE_END });
    const cookie = await signIn(app, db);
    const page = await app.request(`/admin/events/${eventId}`, { headers: { cookie } });
    const token = /name="csrf"[^>]*value="([^"]*)"/.exec(await page.text())?.[1] ?? '';

    const refused = await app.request(`/admin/events/${eventId}/shifts/remove`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams([
        ['csrf', token],
        ['shift[]', String(first)],
        ['shift[]', String(kept)],
      ]),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Cancel this shift, or wait until it has ended, before removing it.');
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE event_id = ?', eventId)).toBe(3);

    const removed = await app.request(`/admin/events/${eventId}/shifts/remove`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams([
        ['csrf', token],
        ['shift[]', String(first)],
        ['shift[]', String(second)],
      ]),
    });
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe(`/admin/events/${eventId}?notice=shifts-removed`);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', first)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', second)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', kept)).toBe(1);
    const after = await app.request(`/admin/events/${eventId}?notice=shifts-removed`, { headers: { cookie } });
    const html = await after.text();
    expect(html).toContain('Those shifts are removed.');
    expect(html).toContain('data-dismiss-notice');
  });
});

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-remove-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  bootstrapAdmin(db, config.bootstrapAdminEmail, NOW);
  return db;
}

async function buildApp() {
  const db = await openDb();
  const config = loadConfig(devEnv({ DATA_DIR: path.join(rootOf(db), 'data') }));
  const app = createApp(config, db, {
    now: NOW,
    clientIp: () => '203.0.113.20',
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db };
}

function rootOf(db: { name: string }): string {
  return path.dirname(path.dirname(db.name));
}

function insertEvent(
  db: Awaited<ReturnType<typeof openDb>>,
  options: { slug?: string; title?: string; published?: number } = {},
): number {
  const saved = db
    .prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', ?, ?, ?)`,
    )
    .run(options.slug ?? 'weekly', options.title ?? 'Weekly pantry', ZONE, options.published ?? 1, NOW);
  return Number(saved.lastInsertRowid);
}

function insertTemplate(db: Awaited<ReturnType<typeof openDb>>, eventId: number, active: number): number {
  const saved = db
    .prepare(
      `INSERT INTO shift_templates (
         event_id, role, weekday, start_local, end_local, capacity, starts_on, active, revision
       ) VALUES (?, 'Sorting', 3, '09:00', '12:00', 6, '2026-10-14', ?, 1)`,
    )
    .run(eventId, active);
  return Number(saved.lastInsertRowid);
}

function insertShift(
  db: Awaited<ReturnType<typeof openDb>>,
  eventId: number,
  options: { cancelled?: number; start?: string; end?: string; templateId?: number; occurrence?: string } = {},
): number {
  const saved = db
    .prepare(
      `INSERT INTO shifts (
         event_id, template_id, occurrence_date, template_revision, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled
       ) VALUES (?, ?, ?, ?, 'Sorting', ?, ?, 3, '', ?)`,
    )
    .run(
      eventId,
      options.templateId ?? null,
      options.templateId ? options.occurrence ?? '2026-10-14' : null,
      options.templateId ? 1 : null,
      options.start ?? '2026-10-14T14:00:00.000Z',
      options.end ?? PAST_END,
      options.cancelled ?? 0,
    );
  return Number(saved.lastInsertRowid);
}

function insertSignup(
  db: Awaited<ReturnType<typeof openDb>>,
  shiftId: number,
  status: 'confirmed' | 'cancelled',
  email = 'ada@example.invalid',
): number {
  const saved = db
    .prepare(
      `INSERT INTO signups (
         shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at
       ) VALUES (?, 'Ada', ?, ?, 0, 1, ?, 0, ?, ?)`,
    )
    .run(shiftId, email, email, status, NOW, NOW);
  return Number(saved.lastInsertRowid);
}

function insertOutbox(db: Awaited<ReturnType<typeof openDb>>, signupId: number, shiftId: number): number {
  const saved = db
    .prepare(
      `INSERT INTO outbox (
         dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
         headers_json, send_after, attempts, status, created_at
       ) VALUES (?, ?, ?, 'cancelled', 'ada@example.invalid', 'Cancelled', 'Gone', '<p>Gone</p>', '{}', ?, 0, 'pending', ?)`,
    )
    .run(`cancelled:${signupId}`, signupId, shiftId, NOW, NOW);
  return Number(saved.lastInsertRowid);
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

async function postRemove(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string, pathName: string, csrf?: string) {
  const current = await app.request(pathName, { headers: { cookie } });
  const token = csrf ?? (/name="csrf"[^>]*value="([^"]*)"/.exec(await current.text())?.[1] ?? '');
  return app.request(pathName, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf: token }),
  });
}

function count(db: Awaited<ReturnType<typeof openDb>>, sql: string, ...params: number[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}
