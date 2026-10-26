import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { issueFormToken } from '../src/form-token.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import { createPostmarkMailer } from '../src/mail/postmark.js';
import { createSesMailer } from '../src/mail/ses.js';
import { createSmtp2GoMailer } from '../src/mail/smtp2go.js';
import { renderConfirmation } from '../src/mail/templates.js';
import type { Mailer } from '../src/mail/types.js';
import { reserveSignup, type ReserveInput } from '../src/signup.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const MAIL = {
  baseUrl: 'http://127.0.0.1:3000',
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

describe('transactional mail', () => {
  it('escapes the person\'s name in HTML and keeps the subject on one line', () => {
    const rendered = renderConfirmation({
      volunteerName: 'Pat <script>\nReview',
      shift: { role: 'Sorting', eventTitle: 'Weekly pantry', location: 'Sioux Center, Iowa', whenLabel: 'Thursday, October 15, 2026, 9:00 AM to 12:00 PM CDT' },
      manageUrl: 'http://127.0.0.1:3000/m/token-value-abcdefghijk',
      replyTo: 'volunteer@example.invalid',
    });
    expect(rendered.subject).toBe("You're signed up for Sorting");
    expect(rendered.subject).not.toContain('\n');
    expect(rendered.html).toContain('Pat &lt;script&gt; Review');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.text).toContain('http://127.0.0.1:3000/m/token-value-abcdefghijk');
  });

  it('queues one confirmation and no second copy on replay', async () => {
    const { db, shiftId } = await buildDb();
    const saved = reserveSignup(db, reservation(shiftId, { email: 'pat@example.invalid', name: 'Pat Review' }));
    expect(saved.ok).toBe(true);
    const rows = db.prepare('SELECT to_email, kind, status FROM outbox ORDER BY id').all();
    expect(rows).toEqual([
      { to_email: 'pat@example.invalid', kind: 'confirmation', status: 'pending' },
    ]);
    const same = reserveSignup(db, reservation(shiftId, { email: 'pat@example.invalid', name: 'Pat Review', operationId: 'same-operation' }));
    expect(same.ok && same.replay).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });

    const other = reserveSignup(db, reservation(shiftId, { email: 'other@example.invalid', operationId: 'other-operation' }));
    expect(other.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE to_email = 'other@example.invalid'").get()).toEqual({ n: 1 });
  });

  it('sends the queued letter once and does not send it again', async () => {
    const { db, shiftId } = await buildDb();
    const saved = reserveSignup(db, reservation(shiftId, { name: 'Pat <b>Review</b>' }));
    expect(saved.ok).toBe(true);
    const seen: string[] = [];
    const mailer: Mailer = {
      async send(message) {
        seen.push(message.html);
        expect(message.from).toBe(MAIL.from);
        expect(message.replyTo).toBe(MAIL.replyTo);
        expect(message.html).toContain('Pat &lt;b&gt;Review&lt;/b&gt;');
        expect(message.html).not.toContain('<b>Review</b>');
        return { result: 'sent', providerId: 'console-1' };
      },
    };
    expect(await deliverDueMail(db, mailer, NOW)).toBe(1);
    expect(await deliverDueMail(db, mailer, NOW)).toBe(0);
    const stored = db.prepare('SELECT status, provider_id, sent_at, body_text FROM outbox').get() as {
      status: string;
      provider_id: string;
      sent_at: string;
      body_text: string;
    };
    expect(stored.status).toBe('sent');
    expect(stored.provider_id).toBe('console-1');
    expect(stored.sent_at).toBe(NOW);
    const token = stored.body_text.match(/\/m\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
    const hash = createHash('sha256').update(token).digest('hex');
    expect(db.prepare('SELECT manage_token_hash FROM signups').get()).toEqual({ manage_token_hash: hash });
    expect(seen).toHaveLength(1);
  });

  it('drops a confirmation that is no longer current and retries only a clear failure', async () => {
    const { db, shiftId } = await buildDb();
    reserveSignup(db, reservation(shiftId, { email: 'gone@example.invalid', operationId: 'gone-operation' }));
    db.prepare("UPDATE signups SET status = 'cancelled' WHERE email_norm = 'gone@example.invalid'").run();
    let calls = 0;
    const unused: Mailer = { async send() { calls += 1; return { result: 'sent', providerId: null }; } };
    expect(await deliverDueMail(db, unused, NOW)).toBe(0);
    expect(calls).toBe(0);
    expect(db.prepare('SELECT status, last_error FROM outbox').get()).toEqual({
      status: 'cancelled',
      last_error: 'The signup changed before this message was sent.',
    });

    reserveSignup(db, reservation(shiftId, { email: 'retry@example.invalid', operationId: 'retry-operation' }));
    const retry: Mailer = { async send() { return { result: 'retry', error: 'busy for retry@example.invalid /m/secret-token-value' }; } };
    expect(await deliverDueMail(db, retry, NOW, () => 0)).toBe(0);
    const waiting = db.prepare("SELECT status, attempts, send_after, last_error FROM outbox WHERE to_email = 'retry@example.invalid'").get() as {
      status: string;
      attempts: number;
      send_after: string;
      last_error: string;
    };
    expect(waiting.status).toBe('pending');
    expect(waiting.attempts).toBe(1);
    expect(waiting.send_after > NOW).toBe(true);
    expect(waiting.last_error).not.toContain('retry@example.invalid');
    expect(waiting.last_error).not.toContain('/m/secret');

    let now = waiting.send_after;
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      expect(await deliverDueMail(db, retry, now, () => 0)).toBe(0);
      const row = db.prepare("SELECT status, attempts, send_after FROM outbox WHERE to_email = 'retry@example.invalid'").get() as {
        status: string;
        attempts: number;
        send_after: string;
      };
      expect(row.attempts).toBe(attempt);
      now = row.send_after;
    }
    expect(db.prepare("SELECT status FROM outbox WHERE to_email = 'retry@example.invalid'").get()).toEqual({ status: 'failed' });
  });

  it('keeps an uncertain send from being sent again, including an expired lease', async () => {
    const { db, shiftId } = await buildDb();
    reserveSignup(db, reservation(shiftId));
    const unknown: Mailer = { async send() { return { result: 'unknown', error: 'timeout' }; } };
    expect(await deliverDueMail(db, unknown, NOW)).toBe(0);
    expect(db.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'delivery_unknown' });
    expect(await deliverDueMail(db, unknown, NOW)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = \'delivery_unknown\'').get()).toEqual({ n: 1 });

    const { db: leased, shiftId: leasedShift } = await buildDb();
    reserveSignup(leased, reservation(leasedShift, { operationId: 'leased-operation' }));
    leased.prepare("UPDATE outbox SET status = 'sending', attempts = 1, claimed_at = ?, lease_expires_at = ?").run(NOW, NOW);
    let called = 0;
    const later = '2026-10-14T18:05:00.000Z';
    expect(await deliverDueMail(leased, { async send() { called += 1; return { result: 'sent', providerId: null }; } }, later)).toBe(0);
    expect(called).toBe(0);
    expect(leased.prepare('SELECT status FROM outbox').get()).toEqual({ status: 'delivery_unknown' });
  });

  it('does not put the volunteer address on the public shift list', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hope-mail-http-'));
    dirs.push(root);
    const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
    const db = await openAppDatabase(config);
    databases.push(db);
    const shiftId = insertShift(db);
    const app = createApp(config, db, {
      now: NOW,
      clientIp: () => '203.0.113.10',
      verifyTurnstile: async () => ({ ok: true }),
    });
    const body = new URLSearchParams({
      form_token: issueFormToken(config.sessionSecret, {
        shiftId,
        issuedAt: Temporal.Instant.from(NOW).epochMilliseconds - 10_000,
        operationId: 'mail-http-operation',
      }),
      first_name: 'Listed',
      last_name: 'Person',
      email: 'listed@example.invalid',
      phone: '712-555-0100',
      notes: '',
      company_website: '',
      'cf-turnstile-response': 'widget-token',
    });
    const saved = await app.request(`/s/${shiftId}`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(saved.status).toBe(303);
    const home = await (await app.request('/')).text();
    expect(home).not.toContain('listed@example.invalid');
    expect(home).not.toContain('Listed Person');
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: 'pending' });
  });
});

describe('mail drivers', () => {
  it('treats SMTP2GO acceptance, a rejected sender, and a lost connection differently', async () => {
    const message = sample();
    const accepted = createSmtp2GoMailer('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6', async (url, init) => {
      expect(String(url)).toBe('https://api.smtp2go.com/v3/email/send');
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Smtp2go-Api-Key']).toBe('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6');
      const body = JSON.parse(String(init?.body)) as {
        sender: string;
        to: string[];
        custom_headers: { header: string; value: string }[];
        fastaccept?: boolean;
      };
      expect(body.sender).toBe(message.from);
      expect(body.to).toEqual([message.to]);
      expect(body.fastaccept).toBeUndefined();
      expect(body.custom_headers).toContainEqual({ header: 'Reply-To', value: message.replyTo });
      expect(String(init?.body)).not.toContain('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6');
      return json({ data: { succeeded: 1, failed: 0, failures: [], email_id: 'smtp2go-1' } }, 200);
    });
    expect(await accepted.send(message)).toEqual({ result: 'sent', providerId: 'smtp2go-1' });

    const rejected = createSmtp2GoMailer('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6', async () => json({
      data: { succeeded: 0, failed: 1, failures: ['From header sender domain not verified for pat@example.invalid'] },
    }, 200));
    const failed = await rejected.send(message);
    expect(failed.result).toBe('failed');
    if (failed.result === 'failed') expect(failed.error).not.toContain('pat@example.invalid');

    const denied = createSmtp2GoMailer('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6', async () => json({
      data: { error: 'You do not have permission', error_code: 'E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED' },
    }, 400));
    expect((await denied.send(message)).result).toBe('failed');

    const busy = createSmtp2GoMailer('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6', async () => new Response('no', { status: 429 }));
    expect((await busy.send(message)).result).toBe('retry');

    const down = createSmtp2GoMailer('api-9f3a2c1e5b8d4f70a1b2c3d4e5f6', async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    expect((await down.send(message)).result).toBe('retry');
  });

  it('treats Postmark acceptance, rejection, and a lost connection differently', async () => {
    const message = sample();
    const accepted = createPostmarkMailer('server-token-value', async (_url, init) => {
      expect(String(init?.headers && (init.headers as Record<string, string>)['X-Postmark-Server-Token'])).toBe('server-token-value');
      expect(String(init?.body)).toContain('Pat Review');
      return json({ ErrorCode: 0, MessageID: 'pm-1' }, 200);
    });
    expect(await accepted.send(message)).toEqual({ result: 'sent', providerId: 'pm-1' });

    const rejected = createPostmarkMailer('server-token-value', async () => json({ ErrorCode: 406, Message: 'Inactive recipient pat@example.invalid' }, 422));
    const failed = await rejected.send(message);
    expect(failed.result).toBe('failed');
    if (failed.result === 'failed') expect(failed.error).not.toContain('pat@example.invalid');

    const busy = createPostmarkMailer('server-token-value', async () => new Response('no', { status: 503 }));
    expect((await busy.send(message)).result).toBe('retry');

    const down = createPostmarkMailer('server-token-value', async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    expect((await down.send(message)).result).toBe('retry');
  });

  it('treats a rejected SES address as permanent and a throttle as retryable', async () => {
    const message = sample();
    const rejected = createSesMailer({
      region: 'us-east-1',
      accessKeyId: 'AKIAexamplekeyvalue',
      secretAccessKey: 'secret-access-key-value',
      client: { async send() { throw Object.assign(new Error('Address pat@example.invalid is not verified'), { name: 'MessageRejected' }); } },
    });
    const failed = await rejected.send(message);
    expect(failed.result).toBe('failed');
    if (failed.result === 'failed') expect(failed.error).not.toContain('pat@example.invalid');

    const throttled = createSesMailer({
      region: 'us-east-1',
      accessKeyId: 'AKIAexamplekeyvalue',
      secretAccessKey: 'secret-access-key-value',
      client: {
        async send(command) {
          expect(command).toBeInstanceOf(SendEmailCommand);
          throw Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' });
        },
      },
    });
    expect((await throttled.send(message)).result).toBe('retry');
  });
});

function sample() {
  return {
    from: MAIL.from,
    to: 'pat@example.invalid',
    replyTo: MAIL.replyTo,
    subject: 'You are signed up',
    text: 'Hello Pat Review',
    html: '<p>Hello Pat Review</p>',
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function buildDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-mail-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return { db, shiftId: insertShift(db) };
}

function insertShift(db: Awaited<ReturnType<typeof openAppDatabase>>): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly-pantry', 'Weekly pantry', 'Bring a hat.', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(NOW).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', 4, '', 0)`,
    ).run(eventId).lastInsertRowid,
  );
}

function reservation(shiftId: number, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    shiftId,
    name: 'Pat Review',
    email: 'pat.review@example.invalid',
    phone: null,
    notes: null,
    operationId: 'same-operation',
    now: NOW,
    mail: MAIL,
    ...overrides,
  };
}
