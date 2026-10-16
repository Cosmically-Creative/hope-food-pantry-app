import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { queueDueReminders } from '../src/reminders.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const MAIL = {
  baseUrl: ORIGIN,
  basePath: '',
  from: 'Hope Food Pantry <volunteer@example.invalid>',
  replyTo: 'volunteer@example.invalid',
};
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('coordinator settings', () => {
  it('asks a signed-out visitor to sign in', async () => {
    const { app } = await buildApp();
    const response = await app.request('/admin/settings');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('shows the defaults, then saves reminder times, reply-to, retention, and privacy wording', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const first = await app.request('/admin/settings', { headers: { cookie } });
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(firstHtml).toContain('value="48"');
    expect(firstHtml).toContain('value="2"');
    expect(firstHtml).toContain('value="volunteer@example.invalid"');
    expect(firstHtml).toContain('value="24"');
    expect(firstHtml).toContain('A spreadsheet already downloaded is left as it is.');
    expect(firstHtml).toContain('does not by itself make it an approved privacy policy');

    const rejected = await postSettings(app, cookie, validFields({ reminder_far: '12', reminder_near: '12' }));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('The two reminder times have to be different.');
    expect(count(db, "SELECT COUNT(*) AS n FROM settings")).toBe(0);

    const named = await postSettings(app, cookie, validFields({ reply_to: 'Hope <pantry@example.invalid>' }));
    expect(named.status).toBe(400);
    expect(await named.text()).toContain('Enter an email address without a display name.');

    const huge = await postSettings(app, cookie, validFields({ privacy_text: 'a'.repeat(8001) }));
    expect(huge.status).toBe(400);
    expect(await huge.text()).toContain('Keep the privacy wording under 8,000 characters.');

    const stale = await app.request('/admin/settings', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf: 'wrong', ...validFields() }),
    });
    expect(stale.status).toBe(403);

    const saved = await postSettings(
      app,
      cookie,
      validFields({
        reminder_far: '3',
        reminder_near: '24',
        reply_to: 'Pantry@Example.invalid',
        retention_months: '12',
        privacy_text: 'We keep names.\n\n<script>alert(1)</script>',
      }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/settings?notice=settings-saved');
    const page = await app.request('/admin/settings?notice=settings-saved', { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Settings saved.');
    expect(html).toContain('value="24"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="pantry@example.invalid"');
    expect(html).toContain('value="12"');
    expect(html).toContain('We keep names.');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');

    const privacy = await app.request('/privacy');
    const privacyHtml = await privacy.text();
    expect(privacyHtml).toContain('We keep names.');
    expect(privacyHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(privacyHtml).not.toContain('<script>');
    expect(privacyHtml).not.toContain('does not have an approved privacy notice yet');

    const audit = db.prepare("SELECT detail_json AS detail_json FROM audit WHERE action = 'settings.update'").all() as { detail_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail_json).toContain('"reminderEarlier":24');
    expect(audit[0]?.detail_json).toContain('"reminderCloser":3');
    expect(audit[0]?.detail_json).toContain('"retentionMonths":12');
    expect(audit[0]?.detail_json).toContain('"replyChanged":1');
    expect(audit[0]?.detail_json).toContain('"privacyChanged":1');
    expect(audit[0]?.detail_json).not.toContain('@');
    expect(audit[0]?.detail_json).not.toContain('We keep names');

    const again = await postSettings(
      app,
      cookie,
      validFields({
        reminder_far: '24',
        reminder_near: '3',
        reply_to: 'pantry@example.invalid',
        retention_months: '12',
        privacy_text: 'We keep names.\n\n<script>alert(1)</script>',
      }),
    );
    expect(again.status).toBe(303);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'settings.update'")).toBe(1);

    await postLogin(app, 'coordinator@example.invalid');
    const letter = db
      .prepare("SELECT headers_json AS headers_json FROM outbox WHERE kind = 'magic_link' AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .get() as { headers_json: string };
    expect(JSON.parse(letter.headers_json)).toMatchObject({ 'Reply-To': 'pantry@example.invalid' });

    const shiftId = insertShift(db);
    insertSignup(db, shiftId);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(1);
    expect(queueDueReminders(db, MAIL, 'dev-only-change-me-not-for-production-use', NOW)).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare('SELECT kind FROM reminders_sent').get()).toEqual({ kind: '24h' });
    const reminder = db.prepare("SELECT headers_json AS headers_json FROM outbox WHERE kind = 'reminder'").get() as { headers_json: string };
    expect(JSON.parse(reminder.headers_json)['Reply-To']).toBe('pantry@example.invalid');
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(1);
  });
});

async function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-settings-'));
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

async function signIn(app: Awaited<ReturnType<typeof buildApp>>['app'], db: Awaited<ReturnType<typeof buildApp>>['db']) {
  await postLogin(app, 'coordinator@example.invalid');
  const token = magicToken(db);
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

async function postSettings(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string, fields: Record<string, string>) {
  const current = await app.request('/admin/settings', { headers: { cookie } });
  const csrf = field(await current.text(), 'csrf');
  return app.request('/admin/settings', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...fields }),
  });
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    reminder_far: '48',
    reminder_near: '2',
    reply_to: 'volunteer@example.invalid',
    retention_months: '24',
    privacy_text: '',
    ...overrides,
  };
}

function insertShift(db: Awaited<ReturnType<typeof buildApp>>['db']): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly', 'Weekly pantry', '', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(NOW).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', 4, '', 0)`,
    ).run(eventId).lastInsertRowid,
  );
}

function insertSignup(db: Awaited<ReturnType<typeof buildApp>>['db'], shiftId: number): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at
     ) VALUES (?, 'Ada', 'ada@example.invalid', 'ada@example.invalid', 0, 1, 'confirmed', 0, ?, ?)`,
  ).run(shiftId, NOW, NOW);
}

function magicToken(db: Awaited<ReturnType<typeof buildApp>>['db']): string {
  const row = db
    .prepare("SELECT body_text AS body_text FROM outbox WHERE kind = 'magic_link' AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get() as { body_text: string } | undefined;
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
