import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTemplate, endTemplate, updateTemplate } from '../src/admin/store.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { expandTemplates } from '../src/recurrence.js';
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

describe('weekly template editing', () => {
  it('keeps generated shifts when a template changes or ends', async () => {
    const db = await openDb();
    const eventId = insertEvent(db);
    const created = createTemplate(db, 1, eventId, templateInput({ weekday: 3, role: 'Sorting' }), NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    const before = shiftRows(db);

    const updated = updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Intake', capacity: 9 }), NOW);
    expect(updated.ok).toBe(true);
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    expect(shiftRows(db)).toEqual(before);
    const template = db.prepare('SELECT role, capacity, revision, active FROM shift_templates WHERE id = ?').get(created.id) as {
      role: string;
      capacity: number;
      revision: number;
      active: number;
    };
    expect(template).toEqual({ role: 'Intake', capacity: 9, revision: 2, active: 1 });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'template.update'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBe(0);

    const ended = endTemplate(db, 1, eventId, created.id, NOW);
    expect(ended.ok).toBe(true);
    expandTemplates(db, NOW, { eventId, coordinatorId: 1 });
    expect(shiftRows(db)).toEqual(before);
    expect((db.prepare('SELECT active FROM shift_templates WHERE id = ?').get(created.id) as { active: number }).active).toBe(0);
    expect(updateTemplate(db, 1, eventId, created.id, templateInput({ weekday: 3, role: 'Sorting' }), NOW).ok).toBe(false);
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
    const generated = await postGenerate(app, eventId, cookie);
    expect(generated.status).toBe(303);
    const wednesdays = count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Sorting'");
    expect(wednesdays).toBe(14);

    const friday = await postTemplate(app, eventId, cookie, { weekday: '5', role: 'Intake', capacity: '4' });
    expect(friday.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-saved`);
    await postGenerate(app, eventId, cookie);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Sorting'")).toBe(wednesdays);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Intake' AND capacity = 4")).toBe(13);
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE template_revision = 1")).toBe(wednesdays + 13);

    const templateId = (
      db.prepare("SELECT id AS id FROM shift_templates WHERE role = 'Intake'").get() as { id: number }
    ).id;
    const edited = await postTemplate(app, eventId, cookie, { weekday: '5', role: 'Packing', capacity: '4', templateId });
    expect(edited.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-saved`);
    expect((db.prepare('SELECT revision, role FROM shift_templates WHERE id = ?').get(templateId) as { revision: number; role: string })).toEqual({
      revision: 2,
      role: 'Packing',
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Intake'")).toBe(13);

    const ended = await postEnd(app, eventId, templateId, cookie);
    expect(ended.headers.get('location')).toBe(`/admin/events/${eventId}?notice=template-ended`);
    const page = await app.request(`/admin/events/${eventId}?notice=template-ended`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('This weekly template has ended. Shifts already on the schedule stay.');
    expect(count(db, "SELECT COUNT(*) AS n FROM shifts WHERE role = 'Intake'")).toBe(13);
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

async function postGenerate(app: Awaited<ReturnType<typeof buildApp>>['app'], eventId: number, cookie: string) {
  const csrf = await csrfFor(app, eventId, cookie);
  return app.request(`/admin/events/${eventId}/generate`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf }),
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

function count(db: Awaited<ReturnType<typeof openDb>>, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}
