import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueCancelToken } from '../src/cancel-token.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { issueFormToken } from '../src/form-token.js';
import { MANAGE_TOKEN_LIMIT } from '../src/rate-limit.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const NOW_MS = Temporal.Instant.from(NOW).epochMilliseconds;
const SECRET = 'dev-only-change-me-not-for-production-use';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('manage-link cancellation', () => {
  it('cancels one signup, frees the spot, and does not send mail', async () => {
    const { app, db, shiftId } = await buildApp({ capacity: 1 });
    const { managePath, token } = await openManage(app, shiftId, 'pat.cancel@example.invalid', '203.0.113.70');
    const before = db.prepare('SELECT status, created_at, updated_at FROM signups').get() as {
      status: string;
      created_at: string;
      updated_at: string;
    };
    const viewed = await app.request(managePath);
    expect(viewed.status).toBe(200);
    expect(await viewed.text()).toContain('Cancel this signup');
    expect(db.prepare('SELECT status, updated_at FROM signups').get()).toEqual({
      status: 'confirmed',
      updated_at: before.updated_at,
    });
    expect(before.created_at).toBe(before.updated_at);

    const full = await app.request(`/s/${shiftId}`);
    expect(await full.text()).toContain('1/1 spots filled');

    const cancelled = await postCancel(app, managePath, token);
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get('location')).toBe(managePath);
    const page = await app.request(managePath);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Cancelled');
    expect(html).toContain('This signup is cancelled');
    expect(html).toContain('Pat Cancel');
    expect(html).not.toContain('<form');
    expect(db.prepare('SELECT status FROM signups').all()).toEqual([{ status: 'cancelled' }]);
    expect(db.prepare('SELECT first_name, last_name, email FROM contacts').get()).toEqual({
      first_name: 'Pat',
      last_name: 'Cancel',
      email: 'pat.cancel@example.invalid',
    });
    expect(db.prepare("SELECT kind, status FROM outbox ORDER BY id").all()).toEqual([
      { kind: 'confirmation', status: 'cancelled' },
      { kind: 'cancelled', status: 'pending' },
    ]);

    const open = await app.request(`/s/${shiftId}`);
    const openHtml = await open.text();
    expect(openHtml).toContain('0/1 spots filled');
    expect(openHtml).not.toContain('pat.cancel@example.invalid');

    const again = await postCancel(app, managePath, token, { ip: '203.0.113.71' });
    expect(again.status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'cancelled'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled'").get()).toEqual({ n: 1 });

    const returned = await postSignup(app, shiftId, { name: 'Pat Cancel', email: 'pat.cancel@example.invalid' }, '203.0.113.72');
    expect(returned.status).toBe(303);
    expect(db.prepare('SELECT status FROM signups ORDER BY id').all()).toEqual([
      { status: 'cancelled' },
      { status: 'confirmed' },
    ]);
    expect((await (await app.request(`/s/${shiftId}`)).text())).toContain('1/1 spots filled');
    const listed = await (await app.request('/?view=calendar')).text();
    expect(listed).toContain('Pat Cancel');
    expect(listed).not.toContain('pat.cancel@example.invalid');
  });

  it('refuses a cancel that did not come from this signup page', async () => {
    const { app, db, shiftId } = await buildApp();
    const first = await openManage(app, shiftId, 'keep@example.invalid', '203.0.113.73');
    const crossSite = await postCancel(app, first.managePath, first.token, { origin: 'https://evil.example', ip: '203.0.113.74' });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain('could not be sent from this page');

    const missing = await postCancel(app, first.managePath, '', { ip: '203.0.113.75' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('could not be confirmed');

    const tampered = `${first.token.slice(0, -1)}${first.token.endsWith('a') ? 'b' : 'a'}`;
    const bad = await postCancel(app, first.managePath, tampered, { ip: '203.0.113.76' });
    expect(bad.status).toBe(400);

    const other = issueCancelToken(SECRET, 'another-manage-token-value');
    const mismatched = await postCancel(app, first.managePath, other, { ip: '203.0.113.77' });
    expect(mismatched.status).toBe(400);
    expect(db.prepare('SELECT status FROM signups').get()).toEqual({ status: 'confirmed' });
    expect(db.prepare("SELECT kind, status FROM outbox").all()).toEqual([{ kind: 'confirmation', status: 'pending' }]);

    const opaque = await postCancel(app, first.managePath, first.token, {
      origin: 'null',
      site: 'same-origin',
      ip: '203.0.113.78',
    });
    expect(opaque.status).toBe(303);
  });

  it('keeps an expired link from cancelling and limits unknown links without storing them', async () => {
    const { app, db, shiftId } = await buildApp();
    const saved = await openManage(app, shiftId, 'later@example.invalid', '203.0.113.80');
    db.prepare("UPDATE signups SET token_expires_at = '2026-10-14T18:00:00.000Z'").run();
    const expired = await postCancel(app, saved.managePath, saved.token, { ip: '203.0.113.80' });
    expect(expired.status).toBe(404);
    expect(await expired.text()).toContain('That page is not available');
    expect(db.prepare('SELECT status FROM signups').get()).toEqual({ status: 'confirmed' });

    const ip = '203.0.113.90';
    for (let index = 0; index < MANAGE_TOKEN_LIMIT; index += 1) {
      const response = await app.request(`/m/not-a-real-token-${index}-abcdefghij`, { headers: { 'x-test-ip': ip } });
      expect(response.status).toBe(404);
    }
    const blocked = await app.request('/m/not-a-real-token-extra-abcdefghij', { headers: { 'x-test-ip': ip } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const blockedHtml = await blocked.text();
    expect(blockedHtml).toContain('Too many attempts');
    expect(blockedHtml).not.toContain('not-a-real-token-extra');

    const otherIp = await app.request('/m/not-a-real-token-other-abcdefghij', { headers: { 'x-test-ip': '203.0.113.91' } });
    expect(otherIp.status).toBe(404);

    const { app: fresh, shiftId: freshShift } = await buildApp();
    const live = await openManage(fresh, freshShift, 'still@example.invalid', ip);
    for (let index = 0; index < MANAGE_TOKEN_LIMIT; index += 1) {
      expect((await fresh.request(`/m/missing-token-${index}-abcdefghijk`, { headers: { 'x-test-ip': ip } })).status).toBe(404);
    }
    expect((await fresh.request(live.managePath, { headers: { 'x-test-ip': ip } })).status).toBe(200);

    const keys = db.prepare('SELECT key FROM rate_hits').all() as { key: string }[];
    const stored = JSON.stringify(keys);
    expect(stored).not.toContain('203.0.113.90');
    expect(stored).not.toContain('not-a-real-token');
  });
});

describe('manage-link switch', () => {
  it('switches to another open shift and replaces the private link', async () => {
    const { app, db, shiftId } = await buildApp({ capacity: 2 });
    const eventId = Number((db.prepare('SELECT id AS id FROM events').get() as { id: number }).id);
    const destinationId = insertShift(db, eventId, 'Distribution', '2026-10-17T14:00:00.000Z', '2026-10-17T17:00:00.000Z', 2);
    const { managePath } = await openManage(app, shiftId, 'pat.switch@example.invalid', '203.0.113.40');
    const signupId = Number((db.prepare('SELECT id AS id FROM signups').get() as { id: number }).id);
    db.prepare('UPDATE signups SET attended = 1 WHERE id = ?').run(signupId);
    db.prepare(
      `INSERT INTO outbox (
         dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
         headers_json, send_after, attempts, status, created_at
       ) VALUES (?, ?, ?, 'reminder', 'pat.switch@example.invalid', 'Reminder', 'Soon', '<p>Soon</p>', '{}', ?, 0, 'pending', ?)`,
    ).run(`reminder:${signupId}`, signupId, shiftId, NOW, NOW);
    const before = await app.request(managePath);
    const html = await before.text();
    expect(before.status).toBe(200);
    expect(optionValues(html)).toEqual([String(destinationId)]);
    expect(html).toContain('<optgroup label="Saturday, October 17, 2026">');
    expect(html).toContain('>Distribution, October 17, 2026, 9:00 AM to 12:00 PM CDT<');
    expect(html).toContain('>Switch<');
    expect(db.prepare('SELECT status, shift_id FROM signups').get()).toEqual({ status: 'confirmed', shift_id: shiftId });

    const switched = await postSwitch(app, managePath, html, String(destinationId));
    expect(switched.status).toBe(303);
    const nextPath = switched.headers.get('location') ?? '';
    expect(nextPath.startsWith('/m/')).toBe(true);
    expect(nextPath.startsWith(managePath)).toBe(false);
    const next = await app.request(nextPath);
    const nextHtml = await next.text();
    expect(next.status).toBe(200);
    expect(nextHtml).toContain('<h2>Distribution</h2>');
    expect(nextHtml).toContain('This link replaces the earlier one.');
    expect(nextHtml).toContain('Confirmed');
    expect(await (await app.request(managePath)).status).toBe(404);

    expect(db.prepare('SELECT status, attended, shift_id FROM signups WHERE id = ?').get(signupId)).toEqual({
      status: 'cancelled',
      attended: 1,
      shift_id: shiftId,
    });
    const created = db.prepare("SELECT status, attended, shift_id FROM signups WHERE status = 'confirmed'").get() as {
      status: string;
      attended: number | null;
      shift_id: number;
    };
    expect(created).toEqual({ status: 'confirmed', attended: null, shift_id: destinationId });
    expect(db.prepare("SELECT status FROM outbox WHERE kind = 'confirmation'").get()).toEqual({ status: 'cancelled' });
    expect(db.prepare("SELECT status FROM outbox WHERE kind = 'reminder'").get()).toEqual({ status: 'cancelled' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled'").get()).toEqual({ n: 0 });
    const letter = db.prepare("SELECT subject, body_text FROM outbox WHERE kind = 'changed'").get() as { subject: string; body_text: string };
    expect(letter.subject).toBe('Your signup was switched to Distribution');
    expect(letter.body_text).toContain('You switched this signup to a different shift.');
    expect(letter.body_text).not.toContain('A coordinator moved');
    expect(letter.body_text).toContain(nextPath.split('?')[0]);
    const home = await (await app.request('/?view=calendar')).text();
    expect(home).not.toContain('pat.switch@example.invalid');
    expect(home).toContain('Pat Cancel');
    expect(home).toContain('0/2 spots filled');
    expect(home).toContain('1/2 spots filled');

    const again = await postSwitch(app, managePath, html, String(destinationId));
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('already switched');
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 1 });
    const audit = db.prepare("SELECT coordinator_id, detail_json FROM audit WHERE action = 'signup.switch'").get() as {
      coordinator_id: number | null;
      detail_json: string;
    };
    expect(audit.coordinator_id).toBeNull();
    expect(audit.detail_json).not.toContain('@');
  });

  it('switches onto a shift that already has the same email for someone else', async () => {
    const { app, db, shiftId } = await buildApp({ capacity: 2 });
    const eventId = Number((db.prepare('SELECT id AS id FROM events').get() as { id: number }).id);
    const openId = insertShift(db, eventId, 'Distribution', '2026-10-17T14:00:00.000Z', '2026-10-17T17:00:00.000Z', 2);
    await openManage(app, openId, 'home.switch@example.invalid', '203.0.113.43');
    db.prepare("UPDATE signups SET name = 'Sam Cancel' WHERE email = 'home.switch@example.invalid'").run();
    const { managePath } = await openManage(app, shiftId, 'home.switch@example.invalid', '203.0.113.44');
    const html = await (await app.request(managePath)).text();
    expect(optionValues(html)).toEqual([String(openId)]);
    const switched = await postSwitch(app, managePath, html, String(openId));
    expect(switched.status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE email = 'home.switch@example.invalid' AND shift_id = ? AND status = 'confirmed'").get(openId)).toEqual({ n: 2 });
  });

  it('keeps the original signup when the switch cannot be saved', async () => {
    const { app, db, shiftId } = await buildApp({ capacity: 2 });
    const eventId = Number((db.prepare('SELECT id AS id FROM events').get() as { id: number }).id);
    const fullId = insertShift(db, eventId, 'Full shift', '2026-10-18T14:00:00.000Z', '2026-10-18T17:00:00.000Z', 1);
    const openId = insertShift(db, eventId, 'Distribution', '2026-10-17T14:00:00.000Z', '2026-10-17T17:00:00.000Z', 2);
    const endedId = insertShift(db, eventId, 'Morning', '2026-10-14T14:00:00.000Z', '2026-10-14T17:00:00.000Z', 2);
    const otherEvent = Number(
      db.prepare(
        `INSERT INTO events (slug, title, description, location, tz, published, created_at)
         VALUES ('other', 'Other', '', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
      ).run(NOW).lastInsertRowid,
    );
    const otherShift = insertShift(db, otherEvent, 'Elsewhere', '2026-10-19T14:00:00.000Z', '2026-10-19T17:00:00.000Z', 2);
    await openManage(app, fullId, 'dee.switch@example.invalid', '203.0.113.41');
    const { managePath } = await openManage(app, shiftId, 'ria.switch@example.invalid', '203.0.113.42');
    const html = await (await app.request(managePath)).text();
    expect(optionValues(html)).toEqual([String(openId)]);

    const full = await postSwitch(app, managePath, html, String(fullId));
    expect(full.status).toBe(400);
    expect(await full.text()).toContain('That shift is full.');
    const ended = await postSwitch(app, managePath, html, String(endedId));
    expect(ended.status).toBe(400);
    expect(await ended.text()).toContain('That shift is closed.');
    const elsewhere = await postSwitch(app, managePath, html, String(otherShift));
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('Choose a shift in this event.');
    db.prepare('UPDATE events SET published = 0 WHERE id = ?').run(eventId);
    const hidden = await postSwitch(app, managePath, html, String(openId));
    expect(hidden.status).toBe(400);
    expect(await hidden.text()).toContain('That shift is not available.');
    const wrong = await postSwitch(app, managePath, html.replace(/name="switch_token" value="[^"]*"/, 'name="switch_token" value="not-a-switch-token-value"'), String(openId));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('could not be confirmed');
    const cancelToken = html.match(/name="cancel_token" value="([^"]+)"/)?.[1] ?? '';
    const reused = await postSwitch(app, managePath, html.replace(/name="switch_token" value="[^"]*"/, `name="switch_token" value="${cancelToken}"`), String(openId));
    expect(reused.status).toBe(400);
    const crossSite = await postSwitch(app, managePath, html, String(openId), { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    expect(db.prepare("SELECT status, shift_id FROM signups WHERE email = 'ria.switch@example.invalid'").get()).toEqual({
      status: 'confirmed',
      shift_id: shiftId,
    });
    expect(db.prepare("SELECT status FROM outbox WHERE to_email = 'ria.switch@example.invalid' AND kind = 'confirmation'").get()).toEqual({
      status: 'pending',
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'signup.switch'").get()).toEqual({ n: 0 });
  });

  it('groups switch choices under each date', async () => {
    const { app, db, shiftId } = await buildApp();
    const eventId = Number((db.prepare('SELECT id AS id FROM events').get() as { id: number }).id);
    const morningId = insertShift(db, eventId, 'Intake', '2026-10-17T14:00:00.000Z', '2026-10-17T16:00:00.000Z', 2);
    const afternoonId = insertShift(db, eventId, 'Distribution', '2026-10-17T19:00:00.000Z', '2026-10-17T21:00:00.000Z', 2);
    const tuesdayId = insertShift(db, eventId, 'Packing', '2026-10-20T14:00:00.000Z', '2026-10-20T17:00:00.000Z', 2);
    const { managePath } = await openManage(app, shiftId, 'date.switch@example.invalid', '203.0.113.45');
    const html = await (await app.request(managePath)).text();
    const select = /<select\b[^>]*\bid="switch-to"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    const saturday = select.indexOf('<optgroup label="Saturday, October 17, 2026">');
    const tuesday = select.indexOf('<optgroup label="Tuesday, October 20, 2026">');
    const morning = select.indexOf(`<option value="${morningId}">`);
    const afternoon = select.indexOf(`<option value="${afternoonId}">`);
    const later = select.indexOf(`<option value="${tuesdayId}">`);
    expect(saturday).toBeGreaterThanOrEqual(0);
    expect(morning).toBeGreaterThan(saturday);
    expect(afternoon).toBeGreaterThan(morning);
    expect(tuesday).toBeGreaterThan(afternoon);
    expect(later).toBeGreaterThan(tuesday);
    expect(select).toContain('>Intake, October 17, 2026, 9:00 AM to 11:00 AM CDT<');
    expect(select).toContain('>Distribution, October 17, 2026, 2:00 PM to 4:00 PM CDT<');
    expect(select).toContain('>Packing, October 20, 2026, 9:00 AM to 12:00 PM CDT<');
    expect(select.match(/<optgroup/g)).toHaveLength(2);
  });
});

async function buildApp(options?: { capacity?: number }) {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-cancel-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly-pantry', 'Weekly pantry', 'Bring a hat.', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(NOW).lastInsertRowid,
  );
  const shiftId = Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', ?, '', 0)`,
    ).run(eventId, options?.capacity ?? 3).lastInsertRowid,
  );
  const app = createApp(config, db, {
    now: NOW,
    clientIp: (c) => c.req.header('x-test-ip') ?? null,
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db, shiftId };
}

async function openManage(app: ReturnType<typeof createApp>, shiftId: number, email: string, ip: string) {
  const saved = await postSignup(app, shiftId, { name: 'Pat Cancel', email }, ip);
  const confirmed = await app.request(saved.headers.get('location') ?? '', {
    headers: { cookie: (saved.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
  });
  const confirmedHtml = await confirmed.text();
  const managePath = confirmedHtml.match(/href="(\/m\/[^"]+)"/)?.[1] ?? '';
  const manage = await app.request(managePath);
  const html = await manage.text();
  const token = html.match(/name="cancel_token" value="([^"]+)"/)?.[1] ?? '';
  expect(managePath.length).toBeGreaterThan(20);
  expect(token).not.toBe(managePath.slice(3));
  expect(html).not.toContain('challenges.cloudflare.com');
  return { managePath, token };
}

async function postSignup(
  app: ReturnType<typeof createApp>,
  shiftId: number,
  fields: { name: string; email: string },
  ip: string,
) {
  const body = new URLSearchParams({
    form_token: issueFormToken(SECRET, {
      shiftId,
      issuedAt: NOW_MS - 10_000,
      operationId: randomBytes(16).toString('hex'),
    }),
    first_name: fields.name.slice(0, fields.name.indexOf(' ')),
    last_name: fields.name.slice(fields.name.indexOf(' ') + 1),
    email: fields.email,
    phone: '712-555-0100',
    notes: '',
    company_website: '',
    'cf-turnstile-response': 'widget-token',
  });
  return app.request(`/s/${shiftId}`, {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/x-www-form-urlencoded',
      'x-test-ip': ip,
    },
    body,
  });
}

function insertShift(db: Awaited<ReturnType<typeof buildApp>>['db'], eventId: number, role: string, starts: string, ends: string, capacity: number) {
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, ?, ?, ?, ?, '', 0)`,
    ).run(eventId, role, starts, ends, capacity).lastInsertRowid,
  );
}

function optionValues(html: string): string[] {
  const select = /<select\b[^>]*\bname="destination"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
  return [...select.matchAll(/value="(\d+)"/g)].map((match) => match[1] ?? '');
}

function postSwitch(
  app: ReturnType<typeof createApp>,
  managePath: string,
  html: string,
  destination: string,
  options?: { origin?: string },
) {
  return app.request(`${managePath}/switch`, {
    method: 'POST',
    headers: {
      origin: options?.origin ?? 'http://127.0.0.1:3000',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      switch_token: field(html, 'switch_token'),
      form_token: field(html, 'form_token'),
      destination,
    }),
  });
}

function field(html: string, name: string): string {
  const tag = new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';
  return /value="([^"]*)"/.exec(tag)?.[1] ?? '';
}

function postCancel(
  app: ReturnType<typeof createApp>,
  managePath: string,
  token: string,
  options?: { origin?: string; site?: string; ip?: string },
) {
  const body = new URLSearchParams();
  if (token) body.set('cancel_token', token);
  return app.request(managePath, {
    method: 'POST',
    headers: {
      origin: options?.origin ?? 'http://127.0.0.1:3000',
      'content-type': 'application/x-www-form-urlencoded',
      'x-test-ip': options?.ip ?? '203.0.113.70',
      ...(options?.site ? { 'sec-fetch-site': options.site } : {}),
    },
    body,
  });
}
