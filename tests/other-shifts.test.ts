import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueCancelToken } from '../src/cancel-token.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { issueFormToken } from '../src/form-token.js';
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

describe('management links are scoped to one signup', () => {
  it('cannot list, cancel, or move a victim signup by reusing their name and email', async () => {
    const { app, db, shiftId } = await buildApp();
    const victimShift = insertShift(db, eventOf(db), 'Distribution', '2026-10-17T14:00:00.000Z', '2026-10-17T17:00:00.000Z', 2);
    insertSignup(db, victimShift, 'Victim Person', 'victim@example.invalid');
    const victimId = signupIdFor(db, victimShift, 'victim@example.invalid');
    const before = db.prepare('SELECT * FROM signups WHERE id = ?').get(victimId);
    const attacker = await openManage(app, db, shiftId, 'victim person', 'victim@example.invalid', '203.0.113.90');
    const html = await (await app.request(attacker.managePath)).text();
    expect(html).not.toContain('Your other shifts');
    expect(html).not.toContain('/also/');
    const token = attacker.managePath.slice(3);
    // Even a previously rendered form with a valid legacy proof must fail.
    for (const suffix of ['', '/switch']) {
      const response = await app.request(`${attacker.managePath}/also/${victimId}${suffix}`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:3000' },
        body: new URLSearchParams({
          cancel_token: legacyProof('cancel', token, victimId),
          switch_token: legacyProof('switch', token, victimId),
          destination: String(shiftId),
        }),
      });
      expect(response.status).toBe(404);
    }
    expect(db.prepare('SELECT * FROM signups WHERE id = ?').get(victimId)).toEqual(before);
    // Their own link remains usable, including after cancellation.
    const cancelled = await app.request(attacker.managePath, {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3000' },
      body: new URLSearchParams({ cancel_token: issueCancelToken(SECRET, token) }),
    });
    expect(cancelled.status).toBe(303);
    expect(await (await app.request(attacker.managePath)).text()).not.toContain('Your other shifts');
    expect(db.prepare('SELECT * FROM signups WHERE id = ?').get(victimId)).toEqual(before);
  });

  it('rejects oversized fixed-length and streamed bodies before signup or login processing', async () => {
    const { app, db, shiftId } = await buildApp();
    for (const route of [`/s/${shiftId}`, '/login']) {
      for (const withLength of [true, false]) {
        const payload = 'name=' + 'A'.repeat(128 * 1024);
        const headers: Record<string, string> = {origin: 'https://invalid.example', 'content-type': 'application/x-www-form-urlencoded'};
        if (withLength) headers['content-length'] = String(payload.length);
        const body = withLength ? payload : new ReadableStream({start(controller) {
          controller.enqueue(new TextEncoder().encode(payload.slice(0, 65536)));
          controller.enqueue(new TextEncoder().encode(payload.slice(65536)));
          controller.close();
        }});
        const response = await app.request(route, {method:'POST', headers, body, duplex:'half'} as RequestInit);
        expect(response.status).toBe(413);
        expect((await response.text()).length).toBeLessThan(100);
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      }
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM signups').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) AS n FROM rate_hits').get()).toEqual({n:0});
  });

  it('does not reflect form data for a rejected origin or a rate-limited request', async () => {
    const { app, shiftId } = await buildApp();
    const send = (origin: string) => app.request(`/s/${shiftId}`, {
      method:'POST', headers:{origin, 'x-test-ip':'203.0.113.91'},
      body:new URLSearchParams({name:'DO-NOT-REFLECT'}),
    });
    const invalid = await send('https://invalid.example');
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).not.toContain('DO-NOT-REFLECT');
    for (let i = 0; i < 5; i++) await send('http://127.0.0.1:3000');
    const limited = await send('http://127.0.0.1:3000');
    expect(limited.status).toBe(429);
    expect(await limited.text()).not.toContain('DO-NOT-REFLECT');
  });
});

async function buildApp(options?: { capacity?: number }) {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-other-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  db.prepare(
    `INSERT INTO events (slug, title, description, location, tz, published, created_at)
     VALUES ('weekly-pantry', 'Weekly pantry', 'Bring a hat.', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
  ).run(NOW);
  const shiftId = insertShift(db, eventOf(db), 'Sorting', '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', options?.capacity ?? 4);
  const app = createApp(config, db, {
    now: NOW,
    clientIp: (c) => c.req.header('x-test-ip') ?? null,
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db, shiftId };
}

function eventOf(db: Database.Database): number {
  return Number((db.prepare('SELECT id AS id FROM events').get() as { id: number }).id);
}

function insertShift(
  db: Database.Database,
  eventId: number,
  role: string,
  starts: string,
  ends: string,
  capacity: number,
) {
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, ?, ?, ?, ?, '', 0)`,
    ).run(eventId, role, starts, ends, capacity).lastInsertRowid,
  );
}

async function openManage(
  app: ReturnType<typeof createApp>,
  db: Database.Database,
  shiftId: number,
  name: string,
  email: string,
  ip: string,
) {
  const saved = await postSignup(app, shiftId, { name, email }, ip);
  expect(saved.status).toBe(303);
  const confirmed = await app.request(saved.headers.get('location') ?? '', {
    headers: { cookie: (saved.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
  });
  const confirmedHtml = await confirmed.text();
  const managePath = confirmedHtml.match(/href="(\/m\/[^"]+)"/)?.[1] ?? '';
  expect(managePath.length).toBeGreaterThan(20);
  const signupId = Number(
    (db.prepare('SELECT id AS id FROM signups WHERE shift_id = ? AND email_norm = ? ORDER BY id DESC LIMIT 1').get(shiftId, email) as { id: number }).id,
  );
  return { managePath, signupId };
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
    name: fields.name,
    email: fields.email,
    phone: '',
    notes: '',
    guardianName: '',
    guardianEmail: '',
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

function insertSignup(db: Database.Database, shiftId: number, name: string, email: string): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, group_size, notes, status,
       manage_token_hash, token_expires_at, reminders_off, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 1, NULL, 'confirmed', ?, '2026-10-24T17:00:00.000Z', 0, ?, ?)`,
  ).run(shiftId, name, email, email, randomBytes(32).toString('hex'), NOW, NOW);
}

function signupIdFor(db: Database.Database, shiftId: number, email: string): number {
  return Number(
    (db.prepare("SELECT id AS id FROM signups WHERE shift_id = ? AND email_norm = ? AND status = 'confirmed'").get(shiftId, email) as { id: number }).id,
  );
}


function legacyProof(action: string, token: string, id: number): string {
  return createHmac('sha256', SECRET).update(`hope-owned-${action}-v1\0${token}\0${id}`).digest('base64url');
}
