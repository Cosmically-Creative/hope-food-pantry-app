import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('administrators', () => {
  it('asks a signed-out visitor to sign in', async () => {
    const { app } = await buildApp();
    const page = await app.request('/admin/admins');
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/login');
    const posted = await app.request('/admin/admins', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Ada Lovelace', email: 'ada@example.invalid' }),
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('/login');
  });

  it('lists the first administrator and adds another who can sign in', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db, 'coordinator@example.invalid');
    const home = await app.request('/admin', { headers: { cookie } });
    expect(await home.text()).toContain('href="/admin/admins"');

    const first = await app.request('/admin/admins', { headers: { cookie } });
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(firstHtml).toContain('Administrator');
    expect(firstHtml).toContain('coordinator@example.invalid');
    expect(firstHtml).toContain('>You</span>');
    expect(firstHtml).toContain('This is the only administrator.');
    expect(firstHtml).not.toContain('Remove this administrator');

    const rejected = await postAdmin(app, cookie, { name: '', email: 'not-an-email' });
    expect(rejected.status).toBe(400);
    const rejectedHtml = await rejected.text();
    expect(rejectedHtml).toContain('Enter a name.');
    expect(rejectedHtml).toContain('Enter an email address.');
    expect(count(db, `SELECT COUNT(*) AS n FROM coordinators`)).toBe(1);

    const broken = await postAdmin(app, cookie, { name: 'Ada\nLovelace', email: 'ada@example.invalid' });
    expect(broken.status).toBe(400);
    expect(await broken.text()).toContain('Enter a name without line breaks.');

    const stale = await app.request('/admin/admins', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf: 'wrong', name: 'Ada Lovelace', email: 'ada@example.invalid' }),
    });
    expect(stale.status).toBe(403);

    const saved = await postAdmin(app, cookie, { name: 'Ada <script> "Lovelace"', email: 'Ada@Example.invalid' });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/admins?notice=admin-added');
    const page = await app.request('/admin/admins?notice=admin-added', { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('That person can sign in.');
    expect(html).toContain('Ada &lt;script&gt;');
    expect(html).not.toContain('Ada <script>');
    expect(html).toContain('ada@example.invalid');
    expect(html).toContain('Remove this administrator');
    expect(html).toContain('Remove your access');
    expect(html.indexOf('ada@example.invalid')).toBeLessThan(html.indexOf('coordinator@example.invalid'));

    const duplicate = await postAdmin(app, cookie, { name: 'Another Ada', email: 'ADA@example.invalid' });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain('That address already has access.');
    expect(count(db, `SELECT COUNT(*) AS n FROM coordinators`)).toBe(2);
    expect(db.prepare(`SELECT name, role, active, password_hash FROM coordinators WHERE email = 'ada@example.invalid'`).get()).toEqual({
      name: 'Ada <script> "Lovelace"',
      role: 'admin',
      active: 1,
      password_hash: null,
    });

    const ada = await signIn(app, db, 'ada@example.invalid');
    const adaHome = await app.request('/admin', { headers: { cookie: ada } });
    expect(await adaHome.text()).toContain('Signed in as <strong>Ada &lt;script&gt; &quot;Lovelace&quot;</strong>');
    expect(auditJson(db)).not.toContain('@');
  });

  it('removes access, keeps the last administrator, and can give the same address access again', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db, 'coordinator@example.invalid');
    const blocked = await app.request('/admin/admins/1/remove', { headers: { cookie } });
    expect(blocked.status).toBe(200);
    expect(await blocked.text()).toContain('Add another administrator before removing this one.');
    const stillThere = await postRemove(app, cookie, 1);
    expect(stillThere.status).toBe(400);
    expect(await stillThere.text()).toContain('Add another administrator before removing this one.');
    expect(db.prepare('SELECT active FROM coordinators WHERE id = 1').get()).toEqual({ active: 1 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);

    await postAdmin(app, cookie, { name: 'Ada Lovelace', email: 'ada@example.invalid' });
    await postLogin(app, 'ada@example.invalid');
    const token = magicToken(db, 'ada@example.invalid');
    const adaId = (db.prepare(`SELECT id AS id FROM coordinators WHERE email = 'ada@example.invalid'`).get() as { id: number }).id;
    const removed = await postRemove(app, cookie, adaId);
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/admin/admins?notice=admin-removed');
    const after = await app.request('/admin/admins?notice=admin-removed', { headers: { cookie } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain('That person can no longer sign in.');
    expect(afterHtml).not.toContain('ada@example.invalid');
    expect((await app.request(`/login/link/${token}`)).status).toBe(404);
    expect(db.prepare(`SELECT status FROM outbox WHERE to_email = 'ada@example.invalid'`).get()).toEqual({ status: 'cancelled' });
    await postLogin(app, 'ada@example.invalid');
    expect(count(db, `SELECT COUNT(*) AS n FROM outbox WHERE to_email = 'ada@example.invalid' AND status = 'pending'`)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);

    const missing = await app.request('/admin/admins/99/remove', { headers: { cookie } });
    expect(missing.status).toBe(404);

    const restored = await postAdmin(app, cookie, { name: 'Ada Restored', email: 'ada@example.invalid' });
    expect(restored.status).toBe(303);
    expect(restored.headers.get('location')).toBe('/admin/admins?notice=admin-restored');
    const again = await app.request('/admin/admins?notice=admin-restored', { headers: { cookie } });
    const againHtml = await again.text();
    expect(againHtml).toContain('That person can sign in again.');
    expect(againHtml).toContain('Ada Restored');
    expect(againHtml).toContain('ada@example.invalid');
    const ada = await signIn(app, db, 'ada@example.invalid');
    expect(await (await app.request('/admin', { headers: { cookie: ada } })).text()).toContain('Signed in as <strong>Ada Restored</strong>');
    expect(auditJson(db)).not.toContain('@');
  });

  it('signs you out when you remove your own access and leaves the other administrator signed in', async () => {
    const { app, db } = await buildApp();
    const keeper = await signIn(app, db, 'coordinator@example.invalid');
    await postAdmin(app, keeper, { name: 'Bea Example', email: 'bea@example.invalid' });
    const bea = await signIn(app, db, 'bea@example.invalid');
    const beaId = (db.prepare(`SELECT id AS id FROM coordinators WHERE email = 'bea@example.invalid'`).get() as { id: number }).id;
    const removed = await postRemove(app, bea, beaId);
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/login');
    expect(removed.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await app.request('/admin', { headers: { cookie: bea } })).status).toBe(303);
    expect((await app.request('/admin', { headers: { cookie: keeper } })).status).toBe(200);
    const home = await app.request('/admin', { headers: { cookie: keeper } });
    expect(await home.text()).toContain('Signed in as <strong>Administrator</strong>');
    expect(db.prepare(`SELECT active FROM coordinators WHERE email = 'bea@example.invalid'`).get()).toEqual({ active: 0 });
  });
});

async function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-admins-'));
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

async function signIn(app: Awaited<ReturnType<typeof buildApp>>['app'], db: Awaited<ReturnType<typeof buildApp>>['db'], email: string) {
  await postLogin(app, email);
  const token = magicToken(db, email);
  const page = await app.request(`/login/link/${token}`);
  const signedIn = await postLink(app, token, field(await page.text(), 'proof'));
  return cookieHeader(signedIn);
}

function postLogin(app: Awaited<ReturnType<typeof buildApp>>['app'], email: string) {
  return app.request('/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, company_website: '', 'cf-turnstile-response': 'token' }),
  });
}

function postLink(app: Awaited<ReturnType<typeof buildApp>>['app'], token: string, proof: string) {
  return app.request(`/login/link/${token}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ proof }),
  });
}

async function postAdmin(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  fields: { name: string; email: string },
) {
  const current = await app.request('/admin/admins', { headers: { cookie } });
  const csrf = field(await current.text(), 'csrf');
  return app.request('/admin/admins', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...fields }),
  });
}

async function postRemove(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string, id: number) {
  const current = await app.request('/admin/admins', { headers: { cookie } });
  const csrf = field(await current.text(), 'csrf');
  return app.request(`/admin/admins/${id}/remove`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf }),
  });
}

function magicToken(db: Awaited<ReturnType<typeof buildApp>>['db'], email: string): string {
  const row = db
    .prepare(
      `SELECT body_text AS body_text
       FROM outbox
       WHERE kind = 'magic_link' AND status = 'pending' AND to_email = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(email) as { body_text: string } | undefined;
  const token = /\/login\/link\/([A-Za-z0-9_-]+)/.exec(row?.body_text ?? '')?.[1];
  if (!token) throw new Error('The sign-in link was not queued.');
  return token;
}

function cookieHeader(response: Response): string {
  const match = /hope_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
  if (!match?.[1]) throw new Error('The session cookie was not set.');
  return `hope_session=${match[1]}`;
}

function field(html: string, name: string): string {
  const tag = new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';
  return /value="([^"]*)"/.exec(tag)?.[1] ?? '';
}

function count(db: Awaited<ReturnType<typeof buildApp>>['db'], sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

function auditJson(db: Awaited<ReturnType<typeof buildApp>>['db']): string {
  return (db.prepare('SELECT detail_json AS detail_json FROM audit').all() as Array<{ detail_json: string }>)
    .map((row) => row.detail_json)
    .join('\n');
}
