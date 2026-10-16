import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { issueFormToken, MIN_FILL_MS } from '../src/form-token.js';
import { SIGNUP_EMAIL_LIMIT, SIGNUP_GUARDIAN_LIMIT, SIGNUP_IP_LIMIT } from '../src/rate-limit.js';
import type { ReserveInput } from '../src/signup.js';
import { verifyTurnstile, type TurnstileVerdict } from '../src/turnstile.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const NOW_MS = Temporal.Instant.from(NOW).epochMilliseconds;
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('capacity-safe signup', () => {
  it('saves one person, shows a private confirmation link, and does not send mail', async () => {
    const { app, shiftId, db } = await buildApp();
    const response = await postSignup(app, shiftId, { name: 'Pat Review', email: ' Pat.Review@Example.invalid ', phone: '712-555-0199', notes: '<script>alert(1)</script>' });
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Pat.Review');
    expect(cookie).not.toContain('pat.review@example.invalid');
    const confirmed = await app.request(locationOf(response), { headers: { cookie: cookiePair(cookie) } });
    const confirmedHtml = await confirmed.text();
    expect(confirmed.status).toBe(200);
    expect(confirmedHtml).toContain('Pat Review');
    expect(confirmedHtml).toContain('A confirmation email is queued');
    expect(confirmedHtml).toContain('where you can cancel it');
    const managePath = confirmedHtml.match(/href="(\/m\/[^"]+)"/)?.[1];
    expect(managePath).toBeTruthy();
    expect(cookie).not.toContain(managePath?.slice(3) ?? 'missing-token');
    const manage = await app.request(managePath ?? '/m/missing');
    const manageHtml = await manage.text();
    expect(manage.status).toBe(200);
    expect(manageHtml).toContain('Pat Review');
    expect(manageHtml).toContain('pat.review@example.invalid');
    expect(manageHtml).toContain('712-555-0199');
    expect(manageHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(manageHtml).toContain('Cancel this signup');
    expect(manageHtml).toContain('name="cancel_token"');
    expect(manageHtml).not.toContain('challenges.cloudflare.com');
    expect(db.prepare("SELECT status FROM signups").get()).toEqual({ status: 'confirmed' });
    expect(manage.headers.get('cache-control')).toBe('no-store');

    const again = await postSignup(app, shiftId, { name: 'Pat Review', email: 'pat.review@example.invalid' }, { ip: '203.0.113.21' });
    expect(again.status).toBe(409);
    const againHtml = await again.text();
    expect(againHtml).toContain('That person is already signed up for this shift.');
    expect(againHtml).not.toContain('already registered');
    expect(againHtml).not.toContain('duplicate');

    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 1 });
  });

  it('lets another person use an email that is already on the shift', async () => {
    const { app, shiftId, db } = await buildApp({ capacity: 2 });
    expect((await postSignup(app, shiftId, { name: 'Pat Review', email: 'home@example.invalid' }, { ip: '203.0.113.91' })).status).toBe(303);
    const second = await postSignup(app, shiftId, { name: 'Sam Review', email: 'Home@Example.invalid' }, { ip: '203.0.113.92' });
    expect(second.status).toBe(303);
    const people = db.prepare("SELECT name, email_norm FROM signups WHERE status = 'confirmed' ORDER BY id").all();
    expect(people).toEqual([
      { name: 'Pat Review', email_norm: 'home@example.invalid' },
      { name: 'Sam Review', email_norm: 'home@example.invalid' },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND to_email = 'home@example.invalid'").get()).toEqual({ n: 2 });
    const again = await postSignup(app, shiftId, { name: 'sam review', email: 'home@example.invalid' }, { ip: '203.0.113.93' });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('That person is already signed up for this shift.');
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 2 });
  });

  it('keeps dots and plus-tags distinct and folds case into one address', async () => {
    const { app, shiftId, db } = await buildApp({ capacity: 4 });
    expect((await postSignup(app, shiftId, { email: 'a.b@example.invalid' }, { ip: '203.0.113.31' })).status).toBe(303);
    expect((await postSignup(app, shiftId, { email: 'ab@example.invalid' }, { ip: '203.0.113.32' })).status).toBe(303);
    expect((await postSignup(app, shiftId, { email: 'a+tag@example.invalid' }, { ip: '203.0.113.33' })).status).toBe(303);
    expect((await postSignup(app, shiftId, { email: 'ADA@Example.invalid' }, { ip: '203.0.113.34' })).status).toBe(303);
    expect((await postSignup(app, shiftId, { email: ' ada@example.invalid ' }, { ip: '203.0.113.35' })).status).toBe(409);
    const emails = db.prepare("SELECT email_norm FROM signups WHERE status = 'confirmed' ORDER BY id").all() as { email_norm: string }[];
    expect(emails.map((row) => row.email_norm)).toEqual([
      'a.b@example.invalid',
      'ab@example.invalid',
      'a+tag@example.invalid',
      'ada@example.invalid',
    ]);
  });

  it('requires a guardian for a minor and ignores guardian fields for an adult', async () => {
    const { app, shiftId, db } = await buildApp({ capacity: 2 });
    const missing = await postSignup(app, shiftId, { under18: true, email: 'minor@example.invalid' }, { ip: '203.0.113.41' });
    expect(missing.status).toBe(400);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain('Enter the guardian name.');
    expect(missingHtml).toMatch(/id="signup-under-18"[^>]*\schecked/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signups').get()).toEqual({ n: 0 });

    const minor = await postSignup(
      app,
      shiftId,
      {
        name: 'Minor Pat',
        email: 'minor@example.invalid',
        under18: true,
        guardianName: 'Guardian Pat',
        guardianEmail: 'Guardian.Pat@Example.invalid',
      },
      { ip: '203.0.113.42' },
    );
    expect(minor.status).toBe(303);
    const adult = await postSignup(
      app,
      shiftId,
      { email: 'adult@example.invalid', guardianName: 'Should Not Store', guardianEmail: 'nope@example.invalid' },
      { ip: '203.0.113.43' },
    );
    expect(adult.status).toBe(303);
    const stored = db.prepare('SELECT email_norm, is_minor, guardian_name, guardian_email, group_size FROM signups ORDER BY id').all();
    expect(stored).toEqual([
      { email_norm: 'minor@example.invalid', is_minor: 1, guardian_name: 'Guardian Pat', guardian_email: 'guardian.pat@example.invalid', group_size: 1 },
      { email_norm: 'adult@example.invalid', is_minor: 0, guardian_name: null, guardian_email: null, group_size: 1 },
    ]);
  });

  it('rejects a fast, tampered, honeypot, cross-site, or unverified submit without taking a spot', async () => {
    const { app, shiftId, db, config } = await buildApp();
    const fast = await postSignup(app, shiftId, {}, { issuedAt: NOW_MS - 1000, ip: '203.0.113.51' });
    expect(fast.status).toBe(400);
    expect(await fast.text()).toContain('wait a few seconds');

    const honeypot = await postSignup(app, shiftId, { company: 'https://spam.example' }, { ip: '203.0.113.52' });
    expect(honeypot.status).toBe(409);
    expect(await honeypot.text()).not.toContain('honeypot');

    const crossSite = await postSignup(app, shiftId, {}, { origin: 'https://evil.example', ip: '203.0.113.53' });
    expect(crossSite.status).toBe(403);
    const opaqueCrossSite = await postSignup(app, shiftId, {}, { origin: 'null', site: 'cross-site', ip: '203.0.113.57' });
    expect(opaqueCrossSite.status).toBe(403);
    const opaqueSameOrigin = await postSignup(app, shiftId, { email: 'same-origin@example.invalid' }, { origin: 'null', site: 'same-origin', ip: '203.0.113.58' });
    expect(opaqueSameOrigin.status).toBe(303);

    const blocked = await buildApp({ verify: async () => ({ ok: false, reason: 'rejected' }) });
    const rejected = await postSignup(blocked.app, blocked.shiftId, {}, { ip: '203.0.113.54' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('check did not finish');

    const down = await buildApp({ verify: async () => ({ ok: false, reason: 'unavailable' }) });
    expect((await postSignup(down.app, down.shiftId, {}, { ip: '203.0.113.55' })).status).toBe(503);

    const tampered = issueFormToken(config.sessionSecret, { shiftId, issuedAt: NOW_MS - 5000, operationId: 'abcdefghijklmnop' });
    const bad = await postSignup(app, shiftId, {}, { token: `${tampered.slice(0, -1)}x`, ip: '203.0.113.56' });
    expect(bad.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signups').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation'").get()).toEqual({ n: 1 });
    void MIN_FILL_MS;
  });

  it('limits signup attempts by IP and by email without storing the raw address', async () => {
    const { app, db } = await buildApp({ capacity: 8 });
    const shifts = [1, 2, 3, 4].map(() => insertExtraShift(db, { capacity: 8 }));
    for (let index = 0; index < SIGNUP_IP_LIMIT; index += 1) {
      const response = await postSignup(app, shifts[0] ?? 0, { email: `ip-${index}@example.invalid` }, { ip: '198.51.100.10' });
      expect(response.status).toBe(303);
    }
    const blockedIp = await postSignup(app, shifts[0] ?? 0, { email: 'ip-extra@example.invalid' }, { ip: '198.51.100.10', forwardedFor: '203.0.113.250' });
    expect(blockedIp.status).toBe(429);
    expect(Number(blockedIp.headers.get('retry-after'))).toBeGreaterThan(0);
    const otherIp = await postSignup(app, shifts[0] ?? 0, { email: 'other-ip@example.invalid' }, { ip: '198.51.100.11' });
    expect(otherIp.status).toBe(303);

    for (let index = 0; index < SIGNUP_EMAIL_LIMIT; index += 1) {
      const shift = shifts[index + 1] ?? 0;
      const response = await postSignup(app, shift, { email: 'daily@example.invalid' }, { ip: `198.51.100.${20 + index}` });
      expect(response.status).toBe(303);
    }
    const blockedEmail = await postSignup(app, shifts[0] ?? 0, { email: 'daily@example.invalid' }, { ip: '198.51.100.40' });
    expect(blockedEmail.status).toBe(429);
    const keys = db.prepare('SELECT key FROM rate_hits').all() as { key: string }[];
    expect(JSON.stringify(keys)).not.toContain('daily@example.invalid');
    expect(JSON.stringify(keys)).not.toContain('198.51.100.10');
  });

  it('limits signups that mail one guardian, even from different volunteer addresses', async () => {
    const { app, db } = await buildApp({ capacity: 8 });
    const shiftId = insertExtraShift(db, { capacity: 8 });
    const minor = (index: number) => ({
      name: `Minor ${index}`,
      email: `minor-${index}@example.invalid`,
      under18: true,
      guardianName: 'Guardian Pat',
      guardianEmail: 'target@example.invalid',
    });
    for (let index = 0; index < SIGNUP_GUARDIAN_LIMIT; index += 1) {
      const response = await postSignup(app, shiftId, minor(index), { ip: `198.51.100.${120 + index}` });
      expect(response.status).toBe(303);
    }
    const blocked = await postSignup(app, shiftId, minor(99), { ip: '198.51.100.140' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(JSON.stringify(db.prepare('SELECT key FROM rate_hits').all())).not.toContain('target@example.invalid');

    const sameAddress = await postSignup(
      app,
      shiftId,
      { name: 'Own Guardian', email: 'family@example.invalid', under18: true, guardianName: 'Parent', guardianEmail: 'family@example.invalid' },
      { ip: '198.51.100.141' },
    );
    expect(sameAddress.status).toBe(303);
  });

  it('does not let a cross-site signup post use up the network allowance', async () => {
    const { app, shiftId } = await buildApp({ capacity: 2 });
    for (let index = 0; index < SIGNUP_IP_LIMIT; index += 1) {
      const rejected = await postSignup(app, shiftId, { email: `cross-${index}@example.invalid` }, {
        origin: 'https://evil.example',
        ip: '198.51.100.77',
      });
      expect(rejected.status).toBe(403);
    }
    const allowed = await postSignup(app, shiftId, { email: 'still-open@example.invalid' }, { ip: '198.51.100.77' });
    expect(allowed.status).toBe(303);
  });

  it('stops at capacity and lets a repeated submit reuse the same reservation', async () => {
    const { app, shiftId, db } = await buildApp({ capacity: 1 });
    const token = issueFormToken('dev-only-change-me-not-for-production-use', {
      shiftId,
      issuedAt: NOW_MS - 10_000,
      operationId: 'repeat-operation-01',
    });
    const first = await postSignup(app, shiftId, { email: 'only@example.invalid' }, { token, ip: '203.0.113.61' });
    const second = await postSignup(app, shiftId, { email: 'only@example.invalid' }, { token, ip: '203.0.113.62' });
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 1 });
    const third = await postSignup(app, shiftId, { email: 'someone@example.invalid' }, { ip: '203.0.113.63' });
    expect(third.status).toBe(409);
    expect(await third.text()).toContain('This shift is full.');
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND status = 'pending'").get()).toEqual({ n: 1 });
  });

  it('does not count a cancelled signup toward capacity and closes ended shifts', async () => {
    const { app, db, shiftId } = await buildApp({ capacity: 1 });
    db.prepare(
      `INSERT INTO signups (
         shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at
       ) VALUES (?, 'Old Person', 'old@example.invalid', 'old@example.invalid', 0, 1, 'cancelled', 0, ?, ?)`,
    ).run(shiftId, NOW, NOW);
    expect((await postSignup(app, shiftId, { email: 'new@example.invalid' }, { ip: '203.0.113.71' })).status).toBe(303);
    const ended = insertExtraShift(db, {
      starts: '2026-10-14T14:00:00.000Z',
      ends: '2026-10-14T17:00:00.000Z',
    });
    const closed = await postSignup(app, ended, { email: 'late@example.invalid' }, { ip: '203.0.113.72' });
    expect(closed.status).toBe(400);
    expect(await closed.text()).toContain('This shift is closed.');
  });

  it('gives exactly three spots to twenty concurrent reservations', async () => {
    const { db, databaseFile, shiftId } = await buildApp({ capacity: 3 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        race(databaseFile, {
          shiftId,
          name: `Person ${index}`,
          email: `person-${index}@example.invalid`,
          phone: null,
          notes: null,
          isMinor: false,
          guardianName: null,
          guardianEmail: null,
          operationId: `operation-${index}-abcdef`,
          now: NOW,
          mail: {
            baseUrl: 'http://127.0.0.1:3000',
            basePath: '',
            from: 'Hope Food Pantry <volunteer@example.invalid>',
            replyTo: 'volunteer@example.invalid',
          },
        }),
      ),
    );
    const wins = results.filter((result) => result.ok && !result.replay);
    expect(wins).toHaveLength(3);
    expect(results.filter((result) => !result.ok && result.reason !== 'full')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COALESCE(SUM(group_size), 0) AS n FROM signups WHERE status = 'confirmed'").get()).toEqual({ n: 3 });
  }, 30_000);

  it('treats an invalid or expired manage link as unavailable', async () => {
    const { app, db, shiftId } = await buildApp();
    const saved = await postSignup(app, shiftId, { email: 'link@example.invalid' }, { ip: '203.0.113.81' });
    const confirmed = await app.request(locationOf(saved), { headers: { cookie: cookiePair(saved.headers.get('set-cookie') ?? '') } });
    const managePath = (await confirmed.text()).match(/href="(\/m\/[^"]+)"/)?.[1] ?? '';
    db.prepare("UPDATE signups SET token_expires_at = '2026-10-14T18:00:00.000Z' WHERE email_norm = 'link@example.invalid'").run();
    expect((await app.request(managePath)).status).toBe(404);
    expect((await app.request('/m/not-a-real-token')).status).toBe(404);
    const missing = await app.request('/m/not-a-real-token');
    expect(await missing.text()).toContain('That page is not available');
    expect(db.prepare("SELECT status FROM signups WHERE email_norm = 'link@example.invalid'").get()).toEqual({ status: 'confirmed' });
  });
});

describe('Turnstile siteverify', () => {
  it('accepts the matching host and action, and fails closed otherwise', async () => {
    const ok = await verifyTurnstile({
      secret: 'secret-key',
      token: 'widget-token',
      remoteIp: '203.0.113.9',
      expectedHostname: '127.0.0.1',
      expectedAction: 'signup',
      fetchImpl: async (_url, init) => {
        expect(String(init?.body)).toContain('secret=secret-key');
        expect(String(init?.body)).toContain('response=widget-token');
        return jsonResponse({ success: true, hostname: '127.0.0.1', action: 'signup' });
      },
    });
    expect(ok).toEqual({ ok: true });
    expect(await verifyTurnstile(check(jsonResponse({ success: true, hostname: 'evil.example', action: 'signup' })))).toEqual({ ok: false, reason: 'rejected' });
    expect(await verifyTurnstile(check(jsonResponse({ success: true, hostname: '127.0.0.1', action: 'login' })))).toEqual({ ok: false, reason: 'rejected' });
    expect(await verifyTurnstile(check(jsonResponse({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }), '1x0000000000000000000000000000000AA'))).toEqual({ ok: true });
    expect(await verifyTurnstile(check(jsonResponse({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } })))).toEqual({ ok: false, reason: 'rejected' });
    expect(await verifyTurnstile(check(jsonResponse({ success: false, 'error-codes': ['timeout-or-duplicate'] })))).toEqual({ ok: false, reason: 'duplicate' });
    expect(await verifyTurnstile(check(Promise.reject(new Error('network'))))).toEqual({ ok: false, reason: 'unavailable' });
  });
});

async function buildApp(options?: { capacity?: number; verify?: (input: unknown) => Promise<TurnstileVerdict> }) {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-signup-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  const shiftId = insertExtraShift(db, { capacity: options?.capacity ?? 3 });
  const app = createApp(config, db, {
    now: NOW,
    clientIp: (c) => c.req.header('x-test-ip') ?? null,
    verifyTurnstile: options?.verify ?? (async () => ({ ok: true })),
  });
  return { app, db, config, shiftId, databaseFile: config.databaseFile };
}

function insertExtraShift(
  db: import('better-sqlite3').Database,
  options?: { capacity?: number; starts?: string; ends?: string; cancelled?: number },
): number {
  const event = db.prepare("SELECT id FROM events WHERE slug = 'weekly-pantry'").get() as { id: number } | undefined;
  const eventId = event?.id ?? Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly-pantry', 'Weekly pantry', 'Bring a hat.', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(NOW).lastInsertRowid,
  );
  const result = db
    .prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', ?, ?, ?, '', ?)`,
    )
    .run(
      eventId,
      options?.starts ?? '2026-10-15T14:00:00.000Z',
      options?.ends ?? '2026-10-15T17:00:00.000Z',
      options?.capacity ?? 3,
      options?.cancelled ?? 0,
    );
  return Number(result.lastInsertRowid);
}

async function postSignup(
  app: ReturnType<typeof createApp>,
  shiftId: number,
  fields: Partial<{ name: string; email: string; phone: string; notes: string; under18: boolean; guardianName: string; guardianEmail: string; company: string }>,
  options?: { token?: string; issuedAt?: number; ip?: string; origin?: string; forwardedFor?: string; site?: string },
) {
  const secret = 'dev-only-change-me-not-for-production-use';
  const token = options?.token ?? issueFormToken(secret, {
    shiftId,
    issuedAt: options?.issuedAt ?? NOW_MS - 10_000,
    operationId: randomBytes(16).toString('hex'),
  });
  const body = new URLSearchParams({
    form_token: token,
    name: fields.name ?? 'Pat Review',
    email: fields.email ?? 'pat.review@example.invalid',
    phone: fields.phone ?? '',
    notes: fields.notes ?? '',
    guardianName: fields.guardianName ?? '',
    guardianEmail: fields.guardianEmail ?? '',
    company_website: fields.company ?? '',
    'cf-turnstile-response': 'widget-token',
  });
  if (fields.under18) body.set('under18', 'yes');
  return app.request(`/s/${shiftId}`, {
    method: 'POST',
    headers: {
      origin: options?.origin ?? 'http://127.0.0.1:3000',
      'content-type': 'application/x-www-form-urlencoded',
      'x-test-ip': options?.ip ?? '203.0.113.10',
      ...(options?.site ? { 'sec-fetch-site': options.site } : {}),
      ...(options?.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
    },
    body,
  });
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? '';
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

function check(result: Promise<Response> | Response, secret = 'secret-key'): Parameters<typeof verifyTurnstile>[0] {
  return {
    secret,
    token: 'widget-token',
    remoteIp: '203.0.113.9',
    expectedHostname: '127.0.0.1',
    expectedAction: 'signup',
    fetchImpl: async () => result,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function race(databaseFile: string, input: ReserveInput): Promise<{ ok: boolean; reason: string | null; replay: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./signup-race-worker.ts', import.meta.url))], {
      env: { ...process.env, HOPE_RACE: JSON.stringify({ databaseFile, input }) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (out.trim() === '') {
        reject(new Error(err || `Signup process exited ${code ?? 'unknown'}.`));
        return;
      }
      resolve(JSON.parse(out));
    });
  });
}
