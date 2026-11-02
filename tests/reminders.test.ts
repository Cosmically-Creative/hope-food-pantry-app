import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveSignup, updateShift } from '../src/admin/store.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import type { Mailer } from '../src/mail/types.js';
import { issueReminderCancelToken } from '../src/cancel-token.js';
import { renderReminder } from '../src/mail/templates.js';
import { issueReminderOffToken } from '../src/reminders.js';
import { queueDueReminders } from '../src/reminders.js';
import { reserveSignup, type ReserveInput } from '../src/signup.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const EARLY = '2026-10-01T15:00:00.000Z';
const INSIDE_START = '2026-10-16T00:00:00.000Z';
const INSIDE_END = '2026-10-16T03:00:00.000Z';
const INSIDE_NEAR = '2026-10-15T22:00:00.000Z';
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
    const saved = reserveSignup(db, reservation(shiftId, { name: 'Pat <script>', now: EARLY }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reminderToken = issueReminderOffToken(SECRET, saved.signupId);
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 1, suppressed: 0 });
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });

    const reminders = db.prepare(`SELECT kind, status, subject, body_text, body_html, headers_json FROM outbox WHERE kind = 'reminder'`).all() as Array<{
      kind: string;
      status: string;
      subject: string;
      body_text: string;
      body_html: string;
      headers_json: string;
    }>;
    expect(reminders).toEqual([
      expect.objectContaining({ kind: 'reminder', status: 'pending', subject: 'Reminder: Sorting' }),
    ]);
    expect(reminders[0]?.body_html).toContain('Pat &lt;script&gt;');
    expect(reminders[0]?.body_html).not.toContain('<script>');
    expect(reminders[0]?.body_html).not.toContain('use the link in your confirmation email');
    expect(reminders[0]?.body_html).toContain(`href="http://127.0.0.1:3000/u/${reminderToken}"`);
    expect(reminders[0]?.body_html).toContain('>Cancel this signup</a>');
    expect(reminders[0]?.body_html).toContain('You confirm before the spot opens for someone else.');
    expect(reminders[0]?.body_html).not.toContain('/cancel');
    expect(reminders[0]?.body_text).toContain(`http://127.0.0.1:3000/u/${reminderToken}`);
    expect(reminders[0]?.body_text).toContain('You confirm before the spot opens for someone else.');
    const headers = JSON.parse(reminders[0]?.headers_json ?? '{}') as Record<string, string>;
    expect(headers['List-Unsubscribe']).toContain(`/u/${reminderToken}`);
    expect(headers['List-Unsubscribe']).not.toContain('/cancel');
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
    reserveSignup(db, reservation(shiftId, { email: 'late@example.invalid', operationId: 'late-signup', now: EARLY }));
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 1, suppressed: 1 });
    const rows = db.prepare(`SELECT status, body_text FROM outbox WHERE kind = 'reminder' ORDER BY id`).all() as Array<{ status: string; body_text: string }>;
    expect(rows.map((row) => row.status)).toEqual(['pending', 'cancelled']);
    expect(rows[1]?.body_text).not.toContain('@');
    expect(db.prepare(`SELECT kind FROM reminders_sent ORDER BY kind`).all()).toEqual([{ kind: '2h' }, { kind: '48h' }]);
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 2 });
  });

  it('does not queue a reminder that was already due before the signup', async () => {
    const db = await openDb();
    const shiftId = insertShift(db, INSIDE_START, INSIDE_END);
    reserveSignup(db, reservation(shiftId, { email: 'thirty@example.invalid', operationId: 'thirty-hours' }));
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT kind FROM outbox`).all()).toEqual([{ kind: 'confirmation' }]);

    expect(queueDueReminders(db, MAIL, SECRET, INSIDE_NEAR)).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare(`SELECT kind FROM reminders_sent`).get()).toEqual({ kind: '2h' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 1 });
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
    reserveSignup(db, reservation(shiftId, { now: EARLY }));
    queueDueReminders(db, MAIL, SECRET, NOW);
    db.prepare(`UPDATE signups SET reminders_off = 1 WHERE email_norm = 'pat.review@example.invalid'`).run();
    const mailer: Mailer = { async send() { return { result: 'sent', providerId: null }; } };
    expect(await deliverDueMail(db, mailer, NOW)).toBe(2);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'notice'`).get()).toEqual({ status: 'sent' });
    expect(db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'reminder'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'Reminders were turned off before this message was sent.',
    });
    expect(db.prepare(`SELECT sent_at FROM reminders_sent`).get()).toEqual({ sent_at: null });

    db.prepare(`UPDATE signups SET reminders_off = 0 WHERE email_norm = 'pat.review@example.invalid'`).run();
    const changed = updateShift(db, 1, shiftId, { role: 'Intake', date: '2026-10-17', start: '09:00', end: '12:00', capacity: 4 }, NOW, MAIL);
    expect(changed.ok).toBe(true);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder' AND subject = 'Reminder: Sorting'`).get()).toEqual({ status: 'cancelled' });
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(queueDueReminders(db, MAIL, SECRET, '2026-10-15T14:00:00.000Z')).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare(`SELECT subject, status FROM outbox WHERE kind = 'reminder' AND status = 'pending'`).get()).toEqual({
      subject: 'Reminder: Intake',
      status: 'pending',
    });
    expect(db.prepare(`SELECT shift_version FROM reminders_sent WHERE kind = '48h' ORDER BY shift_version`).all()).toEqual([
      { shift_version: 1 },
      { shift_version: 2 },
    ]);
  });

  it('does not queue a reminder that was already due before the shift changed', async () => {
    const db = await openDb();
    bootstrapAdmin(db, 'coordinator@example.invalid', EARLY);
    const shiftId = insertShift(db, FAR_START, FAR_END);
    reserveSignup(db, reservation(shiftId, { now: EARLY, operationId: 'before-change' }));
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });

    const changed = updateShift(
      db,
      1,
      shiftId,
      { role: 'Sorting', date: '2026-10-15', start: '19:00', end: '22:00', capacity: 4 },
      NOW,
      MAIL,
    );
    expect(changed.ok).toBe(true);
    expect(db.prepare(`SELECT starts_at_utc AS starts_at_utc FROM shifts WHERE id = ?`).get(shiftId)).toEqual({
      starts_at_utc: INSIDE_START,
    });
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 0 });

    expect(queueDueReminders(db, MAIL, SECRET, INSIDE_NEAR)).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare(`SELECT kind, shift_version FROM reminders_sent`).get()).toEqual({ kind: '2h', shift_version: 2 });
  });

  it('does not queue a reminder that was already due before the signup moved', async () => {
    const db = await openDb();
    bootstrapAdmin(db, 'coordinator@example.invalid', EARLY);
    const sourceId = insertShift(db, FAR_START, FAR_END, 'source-shift');
    const eventId = (db.prepare(`SELECT event_id AS event_id FROM shifts WHERE id = ?`).get(sourceId) as { event_id: number }).event_id;
    const destinationId = insertShiftOnEvent(db, eventId, INSIDE_START, INSIDE_END);
    const saved = reserveSignup(db, reservation(sourceId, { now: EARLY, operationId: 'before-move' }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const moved = moveSignup(db, 1, saved.signupId, destinationId, 'move-inside', NOW, MAIL);
    expect(moved.ok).toBe(true);
    expect(queueDueReminders(db, MAIL, SECRET, NOW)).toEqual({ queued: 0, suppressed: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ n: 0 });

    expect(queueDueReminders(db, MAIL, SECRET, INSIDE_NEAR)).toEqual({ queued: 1, suppressed: 0 });
    expect(db.prepare(`SELECT kind, shift_version FROM reminders_sent`).get()).toEqual({ kind: '2h', shift_version: 1 });
  });

  it('turns reminders off from the email link without cancelling, and leaves a visit unchanged', async () => {
    const { app, db } = await buildApp();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId, { now: EARLY }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    queueDueReminders(db, MAIL, SECRET, NOW);
    const signupId = Number((db.prepare(`SELECT id AS id FROM signups`).get() as { id: number }).id);
    const token = issueReminderOffToken(SECRET, signupId);

    const visit = await app.request(`/u/${token}`);
    expect(visit.status).toBe(200);
    const visitHtml = await visit.text();
    expect(visitHtml).toContain('Stop reminder emails');
    expect(visitHtml).toContain('Cancel this signup');
    expect(visitHtml).toContain(`/u/${token}/cancel`);
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 0, status: 'confirmed' });

    const stopped = await app.request(`/u/${token}`, { method: 'POST' });
    expect(stopped.status).toBe(200);
    expect(await stopped.text()).toContain('Reminder emails are off. This signup stays.');
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 1, status: 'confirmed' });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder' AND status = 'pending'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'confirmation'`).get()).toEqual({ status: 'pending' });

    const again = await app.request(`/u/${token}`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(db.prepare(`SELECT reminders_off FROM signups`).get()).toEqual({ reminders_off: 1 });

    const missing = await app.request('/u/1.not-a-real-mac-value-here');
    expect(missing.status).toBe(404);
    expect(db.prepare(`SELECT reminders_off FROM signups`).get()).toEqual({ reminders_off: 1 });

    const oneClick = await app.request(`/u/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
    });
    expect(oneClick.status).toBe(200);
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 1, status: 'confirmed' });
  });

  it('cancels from the reminder page after a confirmation, and keeps the signup link', async () => {
    const { app, db } = await buildApp();
    bootstrapAdmin(db, 'coordinator@example.invalid', EARLY);
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId, { now: EARLY, groupSize: 1 }));
    expect(saved.ok && saved.manageToken).toBeTruthy();
    if (!saved.ok || !saved.manageToken) return;
    queueDueReminders(db, MAIL, SECRET, NOW);
    const signupId = saved.signupId;
    const token = issueReminderOffToken(SECRET, signupId);

    const confirm = await app.request(`/u/${token}/cancel`);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain('Are you sure you want to cancel?');
    expect(confirmHtml).toContain('Cancel this signup to open the spot for someone else.');
    expect(confirmHtml).toContain('Pat Review');
    expect(confirmHtml).toContain('Sorting');
    expect(db.prepare(`SELECT status FROM signups`).get()).toEqual({ status: 'confirmed' });
    const cancelToken = /name="cancel_token" value="([^"]*)"/.exec(confirmHtml)?.[1] ?? '';
    expect(cancelToken).toBe(issueReminderCancelToken(SECRET, token));

    const crossSite = await postReminderCancel(app, token, cancelToken, { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain('could not be sent from this page');
    const missingToken = await postReminderCancel(app, token, '');
    expect(missingToken.status).toBe(400);
    expect(await missingToken.text()).toContain('could not be confirmed');
    const oneClick = await app.request(`/u/${token}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
    });
    expect(oneClick.status).toBe(403);
    expect(db.prepare(`SELECT status, reminders_off FROM signups`).get()).toEqual({ status: 'confirmed', reminders_off: 0 });

    const cancelled = await postReminderCancel(app, token, cancelToken);
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get('location')).toBe(`/u/${token}`);
    const after = await app.request(`/u/${token}`);
    const afterHtml = await after.text();
    expect(after.status).toBe(200);
    expect(afterHtml).toContain('This signup is cancelled');
    expect(afterHtml).toContain('The spot is open for someone else.');
    expect(afterHtml).not.toContain('name="cancel_token"');
    expect(afterHtml).not.toContain('Stop reminder emails');
    expect(db.prepare(`SELECT status FROM signups`).get()).toEqual({ status: 'cancelled' });
    expect(db.prepare(`SELECT COALESCE(SUM(group_size), 0) AS n FROM signups WHERE status = 'confirmed'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'confirmation'`).get()).toEqual({ status: 'cancelled' });
    expect(db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'reminder'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'The signup was cancelled before this reminder was sent.',
    });
    const letter = db.prepare(`SELECT subject, body_text FROM outbox WHERE kind = 'cancelled'`).get() as { subject: string; body_text: string };
    expect(letter.subject).toBe('Your signup for Sorting is cancelled');
    expect(letter.body_text).toContain(`http://127.0.0.1:3000/u/${token}`);
    expect(letter.body_text).toContain('That link opens the cancelled signup.');
    expect(letter.body_text).not.toContain('/m/');
    expect(db.prepare(`SELECT subject FROM outbox WHERE kind = 'notice' ORDER BY id`).all()).toEqual([
      { subject: 'Pat Review signed up for Sorting' },
      { subject: "Pat Review's signup for Sorting was cancelled" },
    ]);
    const manage = await app.request(`/m/${saved.manageToken}`);
    expect(manage.status).toBe(200);
    expect(await manage.text()).toContain('Cancelled');

    const again = await postReminderCancel(app, token, cancelToken);
    expect(again.status).toBe(303);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'notice'`).get()).toEqual({ n: 2 });
  });

  it('does not cancel a reminder signup after the shift has ended', async () => {
    const { app, db } = await buildApp();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId, { now: EARLY }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const token = issueReminderOffToken(SECRET, saved.signupId);
    db.prepare(`UPDATE shifts SET starts_at_utc = ?, ends_at_utc = ? WHERE id = ?`).run(
      '2026-10-14T15:00:00.000Z',
      '2026-10-14T17:00:00.000Z',
      shiftId,
    );

    const confirm = await app.request(`/u/${token}/cancel`);
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get('location')).toBe(`/u/${token}`);
    const page = await app.request(`/u/${token}`);
    const html = await page.text();
    expect(html).toContain('This shift has ended.');
    expect(html).not.toContain('/cancel');
    const posted = await postReminderCancel(app, token, issueReminderCancelToken(SECRET, token));
    expect(posted.status).toBe(400);
    expect(await posted.text()).toContain('This shift has ended.');
    expect(db.prepare(`SELECT status FROM signups`).get()).toEqual({ status: 'confirmed' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled'`).get()).toEqual({ n: 0 });
  });

  it('names every spot when a reminder is for more than one person', () => {
    const letter = renderReminder({
      volunteerName: 'Pat',
      shift: { role: 'Sorting', eventTitle: 'Weekly pantry', location: 'Sioux Center, Iowa', whenLabel: 'Thursday, October 15, 2026, 9:00 AM to 12:00 PM CDT' },
      unsubscribeUrl: 'https://example.invalid/u/1.token',
      replyTo: 'volunteer@example.invalid',
      groupSize: 3,
    });
    expect(letter.text).toContain('open https://example.invalid/u/1.token');
    expect(letter.text).toContain('You confirm before these 3 spots open for someone else.');
    expect(letter.text).not.toContain('use the link in your confirmation email');
    expect(letter.html).toContain('href="https://example.invalid/u/1.token"');
    expect(letter.html).toContain('these 3 spots');
  });

  it('turns reminders off from the private signup page and keeps the signup', async () => {
    const { app, db } = await buildApp();
    const shiftId = insertShift(db, LATER_START, LATER_END);
    const saved = reserveSignup(db, reservation(shiftId, { now: EARLY }));
    expect(saved.ok && saved.manageToken).toBeTruthy();
    if (!saved.ok || !saved.manageToken) return;
    queueDueReminders(db, MAIL, SECRET, NOW);
    const page = await app.request(`/m/${saved.manageToken}`);
    const html = await page.text();
    const token = /name="reminder_token"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(html).toContain('data-reminder-toggle');

    const stopped = await app.request(`/m/${saved.manageToken}/reminders`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reminder_token: token }),
    });
    expect(stopped.status).toBe(303);
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 1, status: 'confirmed' });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ status: 'cancelled' });
    const after = await app.request(`/m/${saved.manageToken}`);
    const afterHtml = await after.text();
    expect(afterHtml).toContain('name="reminder_token"');
    expect(afterHtml).not.toContain('checked');

    const resumed = await app.request(`/m/${saved.manageToken}/reminders`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reminder_token: token, reminders: 'on' }),
    });
    expect(resumed.status).toBe(303);
    expect(db.prepare(`SELECT reminders_off, status FROM signups`).get()).toEqual({ reminders_off: 0, status: 'confirmed' });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'reminder'`).get()).toEqual({ status: 'pending' });
    const resumedHtml = await (await app.request(`/m/${saved.manageToken}`)).text();
    expect(resumedHtml).toContain('checked');
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

function insertShiftOnEvent(db: Awaited<ReturnType<typeof openDb>>, eventId: number, start: string, end: string): number {
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, 'Intake', ?, ?, 4, '', 0)`,
    ).run(eventId, start, end).lastInsertRowid,
  );
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

function postReminderCancel(
  app: ReturnType<typeof createApp>,
  token: string,
  cancelToken: string,
  options?: { origin?: string },
) {
  return app.request(`/u/${token}/cancel`, {
    method: 'POST',
    headers: {
      origin: options?.origin ?? ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ cancel_token: cancelToken }),
  });
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
