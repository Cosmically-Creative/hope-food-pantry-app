import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateShift } from '../src/admin/store.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import type { Mailer } from '../src/mail/types.js';
import { issueReminderOffToken } from '../src/reminders.js';
import { queueDueReminders } from '../src/reminders.js';
import { reserveSignup, type ReserveInput } from '../src/signup.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const SOON = '2026-10-14T18:30:00.000Z';
const SOON_END = '2026-10-14T20:00:00.000Z';
const LATER_START = '2026-10-15T14:00:00.000Z';
const LATER_END = '2026-10-15T17:00:00.000Z';
const FAR_START = '2026-10-20T14:00:00.000Z';
const FAR_END = '2026-10-20T17:00:00.000Z';
const SECRET = 'dev-only-change-me-not-for-production-use';
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

describe('reminder mail', () => {
  it('queues the 48 hour reminder, sends it once, and records provider acceptance', async () => {
    const db = await openDb();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    reserveSignup(db, reservation(shiftId, { name: 'Pat <script>' }));
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 1, suppressed: 0 });
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });

    const reminders = db.prepare(`SELECT kind, status, subject, body_html, headers_json FROM outbox WHERE kind = 'reminder'`).all() as Array<{
      kind: string;
      status: string;
      subject: string;
      body_html: string;
      headers_json: string;
    }>;
    expect(reminders).toEqual([
      expect.objectContaining({ kind: 'reminder', status: 'pending', subject: 'Reminder: Sorting' }),
    ]);
    expect(reminders[0]?.body_html).toContain('Pat &lt;script&gt;');
    expect(reminders[0]?.body_html).not.toContain('<script>');
    expect(reminders[0]?.body_html).toContain('use the link in your confirmation email');
    const headers = JSON.parse(reminders[0]?.headers_json ?? '{}') as Record<string, string>;
    expect(headers['List-Unsubscribe']).toContain('mailto:volunteer@example.invalid?subject=Stop%20reminder%20emails');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(db.prepare(`SELECT kind, sent_at FROM reminders_sent`).get()).toEqual({ kind: '48h', sent_at: null });

    const seen: string[] = [];
    const mailer: Mailer = {
      async send(message) {
        seen.push(message.subject);
        if (message.subject.startsWith('Reminder:')) {
          expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        }
        return { result: 'sent', providerId: 'reminder-1' };
      },
    };
    expect(await deliverDueMail(db, mailer, NOW)).toBe(2);
    expect(seen).toEqual(["You're signed up for Sorting", 'Reminder: Sorting']);
    expect(db.prepare(`SELECT sent_at FROM reminders_sent`).get()).toEqual({ sent_at: NOW });
    expect(await deliverDueMail(db, mailer, NOW)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 1 });
  });

  it('sends only the closest reminder when several are already due', async () => {
    const db = await openDb();
    const shiftId = insertShift(db, SOON, SOON_END);
    reserveSignup(db, reservation(shiftId, { email: 'late@example.invalid', operationId: 'late-signup' }));
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 1, suppressed: 1 });
    const rows = db.prepare(`SELECT status, body_text FROM outbox WHERE kind = 'reminder' ORDER BY id`).all() as Array<{ status: string; body_text: string }>;
    expect(rows.map((row) => row.status)).toEqual(['pending', 'cancelled']);
    expect(rows[1]?.body_text).not.toContain('@');
    expect(db.prepare(`SELECT kind FROM reminders_sent ORDER BY kind`).all()).toEqual([{ kind: '2h' }, { kind: '48h' }]);
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 2 });
  });

  it('does not queue a reminder after the shift has started, or when reminders are off', async () => {
    const db = await openDb();
    const started = insertShift(db, '2026-10-14T14:00:00.000Z', '2026-10-14T17:00:00.000Z');
    insertConfirmed(db, started, 'started@example.invalid');
    const far = insertShift(db, FAR_START, FAR_END, 'far');
    reserveSignup(db, reservation(far, { email: 'far@example.invalid', operationId: 'far-signup' }));
    const quiet = insertShift(db, LATER_START, LATER_END, 'quiet');
    reserveSignup(db, reservation(quiet, { email: 'quiet@example.invalid', operationId: 'quiet-signup' }));
    db.prepare(`UPDATE signups SET reminders_off = 1 WHERE email_norm = 'quiet@example.invalid'`).run();

    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT status FROM outbox WHERE to_email = 'quiet@example.invalid'`).get()).toEqual({ status: 'pending' });
  });

  it('drops a reminder that is no longer current and queues again after the shift version changes', async () => {
    const db = await openDb();
    bootstrapAdmin(db, 'coordinator@example.invalid', NOW);
    const shiftId = insertShift(db, LATER_START, LATER_END);
    reserveSignup(db, reservation(shiftId));
    queueDueReminders(db, MAIL, SECRET, NOW);
    db.prepare(`UPDATE signups SET reminders_off = 1 WHERE email_norm = 'pat.review@example.invalid'`).run();
    const mailer: Mailer = { async send() { return { result: 'sent', providerId: null }; } };
    expect(await deliverDueMail(db, mailer, NOW)).toBe(1);
    expect(db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'reminder'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'Reminders were turned off before this message was sent.',
    });
    expect(db.prepare(`SELECT sent_at FROM reminders_sent`).get()).toEqual({ sent_at: null });

    db.prepare(`UPDATE signups SET reminders_off = 0 WHERE email_norm = 'pat.review@example.invalid'`).run();
    const changed = updateShift(db, 1, shiftId, { role: 'Intake', date: '2026-10-15', start: '09:00', end: '12:00', capacity: 4 }, NOW, MAIL);
    expect(changed.ok).toBe(true);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder' AND subject = 'Reminder: Sorting'`).get()).toEqual({ status: 'cancelled' });
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare(`SELECT subject, status FROM outbox WHERE kind = 'reminder' AND status = 'pending'`).get()).toEqual({
      subject: 'Reminder: Intake',
      status: 'pending',
    });
    expect(db.prepare(`SELECT shift_version FROM reminders_sent WHERE kind = '48h' ORDER BY shift_version`).all()).toEqual([
      { shift_version: 1 },
      { shift_version: 2 },
    ]);
  });

  it('turns reminders off from the email link without cancelling, and leaves a visit unchanged', async () => {
    const { app, db } = await buildApp();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    queueDueReminders(db, MAIL, SECRET, NOW);
    const signupId = Number((db.prepare(`SELECT id AS id FROM signups`).get() as { id: number }).id);
    const token = issueReminderOffToken(SECRET, signupId);

    const visit = await app.request(`/u/${token}`);
    expect(visit.status).toBe(200);
    expect(await visit.text()).toContain('Stop reminder emails');
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 0, status: 'confirmed' });

    const stopped = await app.request(`/u/${token}`, { method: 'POST' });
    expect(stopped.status).toBe(200);
    expect(await stopped.text()).toContain('Reminder emails for this signup are off.');
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 1, status: 'confirmed' });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder' AND status = 'pending'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'confirmation'`).get()).toEqual({ status: 'pending' });

    const again = await app.request(`/u/${token}`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(db.prepare(`SELECT reminders_off FROM signups`).get()).toEqual({ reminders_off: 1 });

    const missing = await app.request('/u/1.not-a-real-mac-value-here');
    expect(missing.status).toBe(404);
    expect(db.prepare(`SELECT reminders_off FROM signups`).get()).toEqual({ reminders_off: 1 });
  });

  it('turns reminders off from the private signup page and keeps the signup', async () => {
    const { app, db } = await buildApp();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId));
    expect(saved.ok && saved.manageToken).toBeTruthy();
    if (!saved.ok || !saved.manageToken) return;
    const page = await app.request(`/m/${saved.manageToken}`);
    const html = await page.text();
    const token = /name="reminder_token"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(html).toContain('Stop reminder emails');

    const stopped = await app.request(`/m/${saved.manageToken}/reminders`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reminder_token: token }),
    });
    expect(stopped.status).toBe(303);
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 1, status: 'confirmed' });
    const after = await app.request(`/m/${saved.manageToken}`);
    const afterHtml = await after.text();
    expect(afterHtml).toContain('Reminder emails for this signup are off.');
    expect(afterHtml).not.toContain('name="reminder_token"');
  });
});

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-reminder-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return db;
}

async function buildApp() {
  const db = await openDb();
  const config = loadConfig(devEnv({ DATA_DIR: path.join(rootOf(db), 'data') }));
  const app = createApp(config, db, { now: NOW, clientIp: () => '203.0.113.40' });
  return { app, db };
}

function rootOf(db: { name: string }): string {
  return path.dirname(path.dirname(db.name));
}

function insertShift(db: Awaited<ReturnType<typeof openDb>>, start: string, end: string, slug = 'weekly'): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, 'Weekly pantry', '', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(slug, NOW).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Sorting', ?, ?, 4, '', 0)`,
    ).run(eventId, start, end).lastInsertRowid,
  );
}

function insertConfirmed(db: Awaited<ReturnType<typeof openDb>>, shiftId: number, email: string): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, group_size, status, reminders_off, created_at, updated_at,
       manage_token_hash, token_expires_at
     ) VALUES (?, 'Ada', ?, ?, 0, 1, 'confirmed', 0, ?, ?, 'abc', ?)`,
  ).run(shiftId, email, email, NOW, NOW, '2026-10-22T17:00:00.000Z');
}

function reservation(shiftId: number, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    shiftId,
    name: 'Pat Review',
    email: 'pat.review@example.invalid',
    phone: null,
    notes: null,
    operationId: 'reminder-operation',
    now: NOW,
    mail: MAIL,
    ...overrides,
  };
}
