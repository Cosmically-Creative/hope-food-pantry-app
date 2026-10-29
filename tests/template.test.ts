import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemplate, endTemplate, updateTemplate } from '../src/admin/store.js';
import type { MailIdentity } from '../src/mail/types.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { expandTemplates } from '../src/recurrence.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const MAIL: MailIdentity = {
  baseUrl: ORIGIN,
  basePath: '',
  from: 'Hope Food Pantry <volunteer@example.invalid>',
  replyTo: 'volunteer@example.invalid',
};
const ZONE = 'America/Chicago';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('weekly template editing', () => {
  it('updates shifts that have not ended when a template changes, and clears them when it ends', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(shiftRows(db)).toHaveLength(14);

    const updated = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Intake', capacity: 9 }), NOW, MAIL);
    expect(updated).toMatchObject({ ok: true, mailed: 0 });
    const changed = shiftRows(db);
    expect(changed.find((row) => row.occurrence_date === '2026-10-14')).toEqual({
      occurrence_date: '2026-10-14',
      role: 'Sorting',
      capacity: 6,
      template_revision: 1,
      cancelled: 0,
    });
    const upcoming = changed.filter((row) => row.occurrence_date !== '2026-10-14');
    expect(upcoming).toHaveLength(13);
    expect(upcoming.every((row) => row.role === 'Intake' && row.capacity === 9 && row.template_revision === 2 && row.cancelled === 0)).toBe(true);
    const template = db.prepare('SELECT role, capacity, revision, active FROM shift_templates WHERE id = ?').get(created.id) as {
      role: string;
      capacity: number;
      revision: number;
      active: number;
    };
    expect(template).toEqual({ role: 'Intake', capacity: 9, revision: 2, active: 1 });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'template.update'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBe(0);

    const ended = endTemplate(db, 1, eventId, created.id, NOW, MAIL);
    expect(ended.ok).toBe(true);
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    const after = shiftRows(db);
    expect(after).toEqual(changed.filter((row) => row.occurrence_date !== '2026-10-14').map((row) => ({ ...row, cancelled: 1 })));
    expect(after.some((row) => row.occurrence_date === '2026-10-14')).toBe(false);
    expect((db.prepare('SELECT active FROM shift_templates WHERE id = ?').get(created.id) as { active: number }).active).toBe(0);
    expect(updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Sorting' }), NOW, MAIL).ok).toBe(false);
  });

  it('leaves a shift that was edited on its own, and a cancelled date, alone', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.prepare(`UPDATE shifts SET role = 'Custom', manually_modified = 1 WHERE occurrence_date = '2026-10-21'`).run();
    db.prepare(`UPDATE shifts SET cancelled = 1 WHERE occurrence_date = '2026-10-28'`).run();
    insertSignup(db, shiftId(db, '2026-10-21'), 'Ada Example', 'ada@example.invalid');

    const updated = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Intake' }), NOW, MAIL);
    expect(updated).toMatchObject({ ok: true, mailed: 0 });
    expect(db.prepare(`SELECT role, manually_modified, cancelled FROM shifts WHERE occurrence_date = '2026-10-21'`).get()).toEqual({
      role: 'Custom',
      manually_modified: 1,
      cancelled: 0,
    });
    expect(db.prepare(`SELECT role, cancelled FROM shifts WHERE occurrence_date = '2026-10-28'`).get()).toEqual({
      role: 'Sorting',
      cancelled: 1,
    });
    expect(count(db, `SELECT COUNT(*) AS n FROM shifts WHERE occurrence_date = '2026-10-28'`)).toBe(1);
    expect(db.prepare(`SELECT role FROM shifts WHERE occurrence_date = '2026-11-04'`).get()).toEqual({ role: 'Intake' });
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE to_email = 'ada@example.invalid'")).toBe(0);
  });

  it('emails a changed shift, cancels a date that no longer fits, and refuses a capacity below the roster', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    insertSignup(db, shiftId(db, '2026-10-21'), 'Bea Example', 'bea@example.invalid');
    insertSignup(db, shiftId(db, '2026-11-04'), 'Cy Example', 'cy@example.invalid');
    insertSignup(db, shiftId(db, '2026-11-04'), 'Dee Example', 'dee@example.invalid');

    const tooSmall = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, capacity: 1 }), NOW, MAIL);
    expect(tooSmall).toEqual({ ok: false, error: 'Capacity cannot be lower than the number of people signed up.' });
    expect((db.prepare('SELECT capacity, revision FROM shift_templates WHERE id = ?').get(created.id) as { capacity: number; revision: number })).toEqual({
      capacity: 6,
      revision: 1,
    });

    const timed = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, start: '10:00', end: '13:00' }), NOW, MAIL);
    expect(timed).toMatchObject({ ok: true, mailed: 3 });
    expect(db.prepare(`SELECT starts_at_utc, ends_at_utc, role FROM shifts WHERE occurrence_date = '2026-10-21'`).get()).toEqual({
      starts_at_utc: '2026-10-21T15:00:00.000Z',
      ends_at_utc: '2026-10-21T18:00:00.000Z',
      role: 'Sorting',
    });
    expect(db.prepare(`SELECT starts_at_utc FROM shifts WHERE occurrence_date = '2026-10-14'`).get()).toEqual({
      starts_at_utc: '2026-10-14T14:00:00.000Z',
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'changed' AND status = 'pending'")).toBe(3);

    const moved = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 5, start: '10:00', end: '13:00' }), NOW, MAIL);
    expect(moved).toMatchObject({ ok: true, mailed: 3 });
    expect(db.prepare(`SELECT cancelled FROM shifts WHERE occurrence_date = '2026-10-21'`).get()).toEqual({ cancelled: 1 });
    expect(db.prepare(`SELECT cancelled FROM shifts WHERE occurrence_date = '2026-11-04'`).get()).toEqual({ cancelled: 1 });
    expect(db.prepare(`SELECT cancelled, role FROM shifts WHERE occurrence_date = '2026-10-14'`).get()).toEqual({ cancelled: 0, role: 'Sorting' });
    expect(count(db, `SELECT COUNT(*) AS n FROM shifts WHERE occurrence_date >= '2026-10-16' AND cancelled = 0`)).toBe(13);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled' AND status = 'pending'")).toBe(3);
  });

  it('puts a removed date back when the template is saved again', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.prepare(`DELETE FROM shifts WHERE occurrence_date = '2026-10-21'`).run();
    const again = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Sorting' }), NOW, MAIL);
    expect(again).toMatchObject({ ok: true, mailed: 0 });
    expect(count(db, `SELECT COUNT(*) AS n FROM shifts WHERE occurrence_date = '2026-10-21' AND role = 'Sorting'`)).toBe(1);
    expect((db.prepare('SELECT revision FROM shift_templates WHERE id = ?').get(created.id) as { revision: number }).revision).toBe(1);
  });

  it('cancels upcoming template shifts and deletes shifts that already ended', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    const past = db.prepare(`SELECT id AS id FROM shifts WHERE occurrence_date = '2026-10-14'`).get() as { id: number };
    const future = db.prepare(`SELECT id AS id FROM shifts WHERE occurrence_date = '2026-10-21'`).get() as { id: number };
    insertSignup(db, past.id, 'Ada Example', 'ada@example.invalid');
    insertSignup(db, future.id, 'Bea Example', 'bea@example.invalid');

    const ended = endTemplate(db, 1, eventId, created.id, NOW, MAIL);
    expect(ended).toMatchObject({ ok: true, already: false, mailed: 1 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts WHERE id = ?', past.id)).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid'")).toBe(0);
    expect(db.prepare('SELECT cancelled AS cancelled FROM shifts WHERE id = ?').get(future.id)).toEqual({ cancelled: 1 });
    expect(db.prepare("SELECT status AS status FROM signups WHERE email_norm = 'bea@example.invalid'").get()).toEqual({ status: 'cancelled' });
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled' AND to_email = 'bea@example.invalid' AND status = 'pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE to_email = 'ada@example.invalid'")).toBe(0);
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    expect(count(db, `SELECT COUNT(*) AS n FROM shifts WHERE occurrence_date = '2026-10-14'`)).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const audit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'template.end'`).get() as { detail_json: string };
    expect(audit.detail_json).not.toContain('@');
  });

  it('rejects an overnight template and an end date before the first date', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const overnight = createTemplate(db, 1, eventId, templateInput({ weekday: 5, start: '22:00', end: '02:00' }), NOW);
    expect(overnight.ok).toBe(false);
    const backwards = createTemplate(db, 1, eventId, templateInput({ weekday: 5, startsOn: '2026-10-20', endsOn: '2026-10-14' }), NOW);
    expect(backwards.ok).toBe(false);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shift_templates')).toBe(0);
  });

  it('adds only the new weekday and refuses a stale form', async () => {
    const { app, db } = await buildApp();
    const eventId = insertEvent(db);
    const cookie = await signIn(app, db);
    const stale = await postTemplate(app, eventId, cookie, { csrf: 'nope' });
    expect(stale.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM shift_templates')).toBe(0);

    const saved = await postTemplate(app, eventId, cookie, { weekday: '3', role: 'Sorting' });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-saved`);
    const wednesdays = count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Sorting'");
    expect(wednesdays).toBe(14);

    const friday = await postTemplate(app, eventId, cookie, { weekday: '5', role: 'Intake', capacity: '4' });
    expect(friday.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-saved`);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Sorting'")).toBe(wednesdays);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Intake' AND capacity = 4")).toBe(13);

    const templateId = (
      db.prepare("SELECT id AS id FROM shift_templates WHERE role = 'Intake'").get() as { id: number }
    ).id;
    const edited = await postTemplate(app, eventId, cookie, { weekday: '5', role: 'Packing', capacity: '4', templateId });
    expect(edited.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-saved`);
    expect((db.prepare('SELECT revision, role FROM shift_templates WHERE id = ?').get(templateId) as { revision: number; role: string })).toEqual({
      revision: 2,
      role: 'Packing',
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Intake'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Packing' AND template_revision = 2")).toBe(13);

    const ended = await postEnd(app, eventId, templateId, cookie);
    expect(ended.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-ended`);
    const page = await app.request(`/admin/events/${eventId}?notice=template-ended`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('This template has ended. The shifts it added are off this list.');
    expect(html).toContain('Templates');
    expect(html).toContain('Add a template');
    expect(html).toContain('Each one keeps three months of shifts filled.');
    expect(html).not.toContain('Repeating shifts');
    expect(html).not.toContain('Fill missing shifts');
    expect(html).not.toContain('Intake');
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Packing' AND cancelled = 1")).toBe(13);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBe(1);
  });
});

function templateInput(overrides: Partial<{ weekday: number; role: string; capacity: number; start: string; end: string; startsOn: string; endsOn: string | null }>) {
  return {
    role: overrides.role ?? 'Sorting',
    weekday: overrides.weekday ?? 3,
    start: overrides.start ?? '09:00',
    end: overrides.end ?? '12:00',
    capacity: overrides.capacity ?? 6,
    startsOn: overrides.startsOn ?? '2026-10-14',
    endsOn: overrides.endsOn === undefined ? null : overrides.endsOn,
  };
}

function shiftRows(db: Awaited<ReturnType<typeof openDb>>) {
  return db
    .prepare(
      `SELECT occurrence_date, role, capacity, template_revision, cancelled
       FROM shifts ORDER BY occurrence_date`,
    )
    .all();
}

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-template-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  bootstrapAdmin(db, config.bootstrapAdminEmail, NOW);
  return db;
}

async function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-template-'));
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

function insertEvent(db: Awaited<ReturnType<typeof openDb>>): number {
  const saved = db
    .prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly', 'Weekly pantry', '', 'Sioux Center, Iowa', ?, 1, ?)`,
    )
    .run(ZONE, NOW);
  return Number(saved.lastInsertRowid);
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

async function csrfFor(app: Awaited<ReturnType<typeof buildApp>>['app'], eventId: number, cookie: string) {
  const current = await app.request(`/admin/events/${eventId}`, { headers: { cookie } });
  return /name="csrf"[^>]*value="([^"]*)"/.exec(await current.text())?.[1] ?? '';
}

async function postTemplate(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  eventId: number,
  cookie: string,
  fields: { csrf?: string; weekday?: string; role?: string; capacity?: string; templateId?: number },
) {
  const csrf = fields.csrf ?? (await csrfFor(app, eventId, cookie));
  const pathName = fields.templateId ? `/admin/events/${eventId}/templates/${fields.templateId}` : `/admin/events/${eventId}/templates`;
  return app.request(pathName, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      role: fields.role ?? 'Sorting',
      weekday: fields.weekday ?? '3',
      start: '09:00',
      end: '12:00',
      capacity: fields.capacity ?? '6',
      startsOn: '2026-10-14',
      endsOn: '',
    }),
  });
}

async function postEnd(app: Awaited<ReturnType<typeof buildApp>>['app'], eventId: number, templateId: number, cookie: string) {
  const csrf = await csrfFor(app, eventId, cookie);
  return app.request(`/admin/events/${eventId}/templates/${templateId}/end`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf }),
  });
}

function count(db: Awaited<ReturnType<typeof openDb>>, sql: string, ...params: Array<number | string>): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function shiftId(db: Awaited<ReturnType<typeof openDb>>, date: string): number {
  return (db.prepare('SELECT id AS id FROM shifts WHERE occurrence_date = ?').get(date) as { id: number }).id;
}

function insertSignup(db: Awaited<ReturnType<typeof openDb>>, shiftId: number, name: string, email: string): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 1, 'confirmed', 0, ?, ?)`,
  ).run(shiftId, name, email, email, NOW, NOW);
}
