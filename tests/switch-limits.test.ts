import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import { SWITCH_IP_LIMIT, SWITCH_RECIPIENT_LIMIT } from '../src/rate-limit.js';
import { reserveSignup } from '../src/signup.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const dirs: string[] = [];
const databases = new Set<Database.Database>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('public switch limits', () => {
  it('stops the repeated-switch mail attack despite new tokens, ids, IPs, and a reopened database', async () => {
    const f = await fixture();
    // A shared volunteer/guardian mailbox must count only once per switch.
    let link = f.signup('target@example.invalid', 'target@example.invalid');
    let app = f.app();
    let accepted = 0;
    const mailer = { send: async () => { accepted++; return { result: 'sent' as const, providerId: 'mock' }; } };
    await deliverDueMail(f.db, mailer, NOW);
    for (let i = 0; i < SWITCH_RECIPIENT_LIMIT; i++) {
      const response = await switchTo(app, link, f.shifts[(i + 1) % 2]!, `203.0.113.${i + 1}`);
      expect(response.status).toBe(303);
      link = nextLink(response);
      await deliverDueMail(f.db, mailer, NOW);
    }
    const before = records(f.db);
    // Close and reopen the file, rather than relying on an in-memory counter.
    f.db.close();
    databases.delete(f.db);
    const reopened = await openAppDatabase(f.config);
    databases.add(reopened);
    app = createApp(f.config, reopened, { now: NOW, clientIp: (c) => c.req.header('x-test-ip') ?? null });
    for (let i = SWITCH_RECIPIENT_LIMIT; i < 12; i++) {
      const response = await switchTo(app, link, f.shifts[0]!, `203.0.113.${i + 1}`);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('39600'); // Midnight in America/Chicago.
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('You are still signed up for this shift.');
      expect(records(reopened)).toEqual(before);
      await deliverDueMail(reopened, mailer, NOW);
    }
    expect(accepted).toBe(1 + SWITCH_RECIPIENT_LIMIT);
    expect(before.signups).toHaveLength(1 + SWITCH_RECIPIENT_LIMIT);
    expect(JSON.stringify(reopened.prepare('SELECT * FROM rate_hits').all())).not.toMatch(/target@|203\.0\.113/);
    const tomorrow = createApp(f.config, reopened, { now: '2026-10-15T05:00:00.000Z', clientIp: () => '203.0.113.1' });
    expect((await switchTo(tomorrow, link, f.shifts[0]!)).status).toBe(303);
  });

  it('shares guardian limits across children, IPs, and recipient roles without charging blocked co-recipients', async () => {
    const f = await fixture();
    const app = f.app();
    for (let i = 0; i < SWITCH_RECIPIENT_LIMIT; i++) {
      const link = f.signup(`child${i}@example.invalid`, 'guardian@example.invalid');
      expect((await switchTo(app, link, f.shifts[1]!, `203.0.113.${i + 1}`)).status).toBe(303);
    }
    const blocked = f.signup('new-child@example.invalid', 'guardian@example.invalid');
    const before = records(f.db);
    expect((await switchTo(app, blocked, f.shifts[1]!, '203.0.113.99')).status).toBe(429);
    expect(records(f.db)).toEqual(before);
    const reversed = f.signup('guardian@example.invalid', 'other@example.invalid');
    expect((await switchTo(app, reversed, f.shifts[1]!, '203.0.113.98')).status).toBe(429);
    // Rejection must not spend this child's allowance on otherwise valid links.
    let ownLink = f.signup('new-child@example.invalid', null, 'Another person');
    for (let i = 0; i < SWITCH_RECIPIENT_LIMIT; i++) {
      const response = await switchTo(app, ownLink, f.shifts[(i + 1) % 2]!, '203.0.113.97');
      expect(response.status).toBe(303);
      ownLink = nextLink(response);
    }
  });

  it('limits one IP even when recipients change, then permits a retry after the window', async () => {
    const f = await fixture();
    const app = f.app();
    for (let i = 0; i < SWITCH_IP_LIMIT; i++) {
      const link = f.signup(`person${i}@example.invalid`);
      expect((await switchTo(app, link, f.shifts[1]!, '203.0.113.1')).status).toBe(303);
    }
    const link = f.signup('next@example.invalid');
    const before = records(f.db);
    const limited = await switchTo(app, link, f.shifts[1]!, '203.0.113.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(records(f.db)).toEqual(before);
    const later = f.app('2026-10-14T18:10:00.000Z');
    expect((await switchTo(later, link, f.shifts[1]!, '203.0.113.1')).status).toBe(303);
  });

  it('does not charge recipients for invalid origin or forged proofs', async () => {
    const f = await fixture();
    const app = f.app();
    const link = f.signup('proof@example.invalid');
    const page = await (await app.request(link)).text();
    for (const origin of ['https://invalid.example', f.config.baseUrl]) {
      const response = await app.request(`${link}/switch`, {
        method: 'POST', headers: { origin },
        body: new URLSearchParams({ switch_token: 'forged', form_token: field(page, 'form_token'), destination: String(f.shifts[1]) }),
      });
      expect(response.status).toBe(origin === f.config.baseUrl ? 400 : 403);
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rate_hits').get()).toEqual({ n: 0 });
  });

  it('does not overshoot a shared recipient limit under concurrent requests', async () => {
    const f = await fixture();
    const app = f.app();
    const requests = Array.from({ length: SWITCH_RECIPIENT_LIMIT + 1 }, (_, i) => {
      const link = f.signup(`parallel${i}@example.invalid`, 'shared@example.invalid');
      return switchTo(app, link, f.shifts[1]!, `203.0.113.${i + 1}`);
    });
    const responses = await Promise.all(requests);
    expect(responses.filter((r) => r.status === 303)).toHaveLength(SWITCH_RECIPIENT_LIMIT);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='signup.switch'").get()).toEqual({ n: SWITCH_RECIPIENT_LIMIT });
  });

  it('keeps replays idempotent and cancellation available after reaching the switch limit', async () => {
    const f = await fixture();
    const app = f.app();
    let link = f.signup('cancel@example.invalid');
    for (let i = 0; i < SWITCH_RECIPIENT_LIMIT; i++) {
      const page = await (await app.request(link)).text();
      const request = () => postSwitch(app, link, page, f.shifts[(i + 1) % 2]!, '203.0.113.1');
      const response = await request();
      expect(response.status).toBe(303);
      const before = records(f.db);
      const rates = f.db.prepare('SELECT * FROM rate_hits ORDER BY key').all();
      expect((await request()).status).toBe(200);
      expect(records(f.db)).toEqual(before);
      expect(f.db.prepare('SELECT * FROM rate_hits ORDER BY key').all()).toEqual(rates);
      link = nextLink(response);
    }
    expect((await switchTo(app, link, f.shifts[0]!)).status).toBe(429);
    const page = await (await app.request(link)).text();
    const cancel = await app.request(link, {
      method: 'POST', headers: { origin: f.config.baseUrl },
      body: new URLSearchParams({ cancel_token: field(page, 'cancel_token') }),
    });
    expect(cancel.status).toBe(303);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM signups WHERE status='confirmed'").get()).toEqual({ n: 0 });
  });
});

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hope-switch-limit-'));
  dirs.push(dir);
  const config = loadConfig(devEnv({ DATA_DIR: dir }));
  const db = await openAppDatabase(config);
  databases.add(db);
  const eventId = db.prepare(`INSERT INTO events (slug,title,description,location,tz,published,created_at)
    VALUES ('weekly-pantry','Pantry','','Iowa','America/Chicago',1,?)`).run(NOW).lastInsertRowid;
  const shifts = [0, 1].map((i) => Number(db.prepare(`INSERT INTO shifts
    (event_id,role,starts_at_utc,ends_at_utc,capacity,notes,cancelled)
    VALUES (?,?, '2026-10-16T14:00:00.000Z','2026-10-16T17:00:00.000Z',100,'',0)`)
    .run(eventId, `Role ${i}`).lastInsertRowid));
  const mail = { baseUrl: config.baseUrl, basePath: config.basePath, from: config.mail.from, replyTo: config.mail.replyTo };
  return {
    db, config, shifts,
    app: (now = NOW) => createApp(config, db, { now, clientIp: (c) => c.req.header('x-test-ip') ?? null }),
    signup: (email: string, guardianEmail: string | null = null, name = 'Test Person') => {
      const result = reserveSignup(db, {
        shiftId: shifts[0]!, name, email, guardianEmail, isMinor: guardianEmail !== null,
        guardianName: guardianEmail ? 'Guardian' : null, phone: null, notes: null,
        operationId: randomBytes(16).toString('hex'), now: NOW, mail,
      });
      if (!result.ok || !result.manageToken) throw new Error('Fixture signup failed');
      return `/m/${result.manageToken}`;
    },
  };
}

function records(db: Database.Database) {
  return {
    signups: db.prepare('SELECT * FROM signups ORDER BY id').all(),
    outbox: db.prepare('SELECT * FROM outbox ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY id').all(),
  };
}

function field(html: string, name: string): string {
  const input = new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';
  return /value="([^"]*)"/.exec(input)?.[1] ?? '';
}

function nextLink(response: Response): string {
  const location = response.headers.get('location');
  if (!location) throw new Error('Missing management redirect');
  return location.split('?')[0]!;
}

async function switchTo(app: ReturnType<typeof createApp>, link: string, destination: number, ip = '203.0.113.1') {
  const page = await (await app.request(link)).text();
  return postSwitch(app, link, page, destination, ip);
}

function postSwitch(app: ReturnType<typeof createApp>, link: string, page: string, destination: number, ip: string) {
  return app.request(`${link}/switch`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3000', 'x-test-ip': ip, 'x-forwarded-for': '198.51.100.99' },
    body: new URLSearchParams({
      switch_token: field(page, 'switch_token'), form_token: field(page, 'form_token'), destination: String(destination),
    }),
  });
}
