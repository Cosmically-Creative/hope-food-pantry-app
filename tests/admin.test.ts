import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCEPTED } from '../src/admin-pages.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { recoverCoordinator } from '../src/auth/recover.js';
import { sessionClearCookie, sessionSetCookie } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import { renderMagicLink } from '../src/mail/templates.js';
import type { Mailer, OutboundMail } from '../src/mail/types.js';
import { LOGIN_IP_LIMIT } from '../src/rate-limit.js';
import { readManageSignup, reserveSignup } from '../src/signup.js';
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

describe('coordinator sign-in', () => {
  it('uses the same response for an active coordinator and anyone else', async () => {
    const active = await buildApp();
    const inactive = await buildApp();
    inactive.db.prepare('UPDATE coordinators SET active = 0').run();
    const known = await postLogin(active.app, 'coordinator@example.invalid');
    const stranger = await postLogin(active.app, 'missing@example.invalid');
    const closed = await postLogin(inactive.app, 'coordinator@example.invalid');
    const knownHtml = await known.text();
    const strangerHtml = await stranger.text();
    const closedHtml = await closed.text();
    expect(known.status).toBe(200);
    expect(stranger.status).toBe(200);
    expect(closed.status).toBe(200);
    expect(knownHtml).toBe(strangerHtml);
    expect(knownHtml).toBe(closedHtml);
    expect(knownHtml).toContain(ACCEPTED);
    expect(knownHtml).not.toContain('not found');
    expect(knownHtml).not.toContain('/login/link/');
    expect(known.headers.get('set-cookie')).toBeNull();
    expect(count(active.db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'magic_link'")).toBe(1);
    expect(count(inactive.db, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
  });

  it('does not sign in when the link is only opened', async () => {
    const { app, db } = await buildApp();
    await postLogin(app, 'coordinator@example.invalid');
    const token = magicToken(db);
    const opened = await app.request(`/login/link/${token}`);
    const html = await opened.text();
    expect(opened.status).toBe(200);
    expect(html).toContain('The link works once');
    expect(html).not.toContain(LINK_GONE);
    expect(opened.headers.get('set-cookie')).toBeNull();
    expect(usedAt(db, token)).toBeNull();
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);

    const ignored = await postLink(app, token, 'not-the-proof-value-000000000000');
    expect(ignored.status).toBe(404);
    expect(usedAt(db, token)).toBeNull();

    const proof = field(html, 'proof');
    const signedIn = await postLink(app, token, proof);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/admin');
    const setCookie = signedIn.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('@');
    expect(usedAt(db, token)).toBe(NOW);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);

    const again = await postLink(app, token, proof);
    expect(again.status).toBe(404);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);
    const home = await app.request('/admin', { headers: { cookie: cookieHeader(signedIn) } });
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('Signed in as <strong>Administrator</strong>');
    expect(homeHtml).toContain('No database backup has been saved yet.');
    expect(homeHtml).not.toContain('coordinator@example.invalid');
  });

  it('shows the day this sign-in ends, and opening the desk does not move that day', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const home = await app.request('/admin', { headers: { cookie } });
    expect(await home.text()).toContain('This sign-in ends on Wednesday, October 28, 2026.');
    expect(db.prepare('SELECT expires_at AS expires_at FROM sessions').get()).toEqual({
      expires_at: '2026-10-28T18:00:00.000Z',
    });

    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ?').run('2026-11-05T04:30:00.000Z', '2026-10-20T18:00:00.000Z');
    const later = await app.request('/admin', { headers: { cookie } });
    const laterHtml = await later.text();
    expect(laterHtml).toContain('This sign-in ends on Wednesday, November 4, 2026.');
    expect(laterHtml).not.toContain('Thursday, November 5, 2026');
    expect(db.prepare('SELECT expires_at AS expires_at, last_seen_at AS last_seen_at FROM sessions').get()).toEqual({
      expires_at: '2026-11-05T04:30:00.000Z',
      last_seen_at: NOW,
    });
  });

  it('shows a backup from today as a short status tag', async () => {
    const { app, db, config } = await buildApp();
    mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
    writeFileSync(path.join(config.dataDir, 'backups', 'daily-2026-10-14.db'), '');
    const cookie = await signIn(app, db);
    const home = await app.request('/admin', { headers: { cookie } });
    const homeHtml = await home.text();
    expect(homeHtml).toContain('class="desk-note is-saved"');
    expect(homeHtml).toContain('Backup saved today');
    expect(homeHtml).not.toContain('Database backup saved');
  });

  it('still accepts a valid link after other guesses from the same network', async () => {
    const { app, db } = await buildApp();
    await postLogin(app, 'coordinator@example.invalid');
    const token = magicToken(db);
    for (let index = 0; index < 20; index += 1) {
      const guess = await postLink(app, `not-a-real-token-value-${index}xxxx`, 'also-not-a-real-proof-value-0001');
      expect(guess.status).toBe(404);
    }
    const page = await app.request(`/login/link/${token}`);
    const signedIn = await postLink(app, token, field(await page.text(), 'proof'));
    expect(signedIn.status).toBe(303);
    const blocked = await postLink(app, 'not-a-real-token-value-finalxxx', 'also-not-a-real-proof-value-0001');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('limits sign-in requests for one address', async () => {
    const { app } = await buildApp();
    for (let index = 0; index < 3; index += 1) {
      const response = await postLogin(app, 'coordinator@example.invalid');
      expect(response.status).toBe(200);
    }
    const limited = await postLogin(app, 'coordinator@example.invalid');
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('Too many sign-in attempts');
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('does not let a cross-site sign-in post use up the network allowance', async () => {
    const { app } = await buildApp();
    for (let index = 0; index < LOGIN_IP_LIMIT; index += 1) {
      const rejected = await app.request('/login', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'coordinator@example.invalid', 'cf-turnstile-response': 'token' }),
      });
      expect(rejected.status).toBe(403);
    }
    const allowed = await postLogin(app, 'coordinator@example.invalid');
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain(ACCEPTED);
  });

  it('creates the first administrator once and does not replace that account', async () => {
    const { db, created } = await buildApp();
    expect(created).toEqual({ created: true });
    expect(bootstrapAdmin(db, 'other@example.invalid', NOW)).toEqual({ created: false });
    expect(db.prepare('SELECT email, name, role, password_hash, active FROM coordinators').get()).toEqual({
      email: 'coordinator@example.invalid',
      name: 'Administrator',
      role: 'admin',
      password_hash: null,
      active: 1,
    });
  });

  it('revokes sessions from the host recovery command and can replace the address', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(200);
    const result = recoverCoordinator(db, {
      email: 'coordinator@example.invalid',
      replaceWith: 'next@example.invalid',
      now: NOW,
    });
    expect(result).toEqual({ coordinatorId: 1 });
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(303);
    await postLogin(app, 'coordinator@example.invalid');
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'magic_link' AND status = 'pending' AND to_email = 'coordinator@example.invalid'")).toBe(0);
    await postLogin(app, 'next@example.invalid');
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'magic_link' AND status = 'pending' AND to_email = 'next@example.invalid'")).toBe(1);
    expect(auditJson(db)).not.toContain('@');
  });

  it('sends a sign-in link without using it, and drops an expired one', async () => {
    const sent: OutboundMail[] = [];
    const mailer: Mailer = { send: async (message) => { sent.push(message); return { result: 'sent', providerId: 'local' }; } };
    const fresh = await buildApp();
    await postLogin(fresh.app, 'coordinator@example.invalid');
    const token = magicToken(fresh.db);
    expect(await deliverDueMail(fresh.db, mailer, NOW, () => 0.5)).toBe(1);
    expect(sent[0]?.text).toContain(`/login/link/${token}`);
    expect(sent[0]?.text).toContain('expires in 15 minutes');
    expect(sent[0]?.text).toContain('Opening the link does not sign you in');
    expect(usedAt(fresh.db, token)).toBeNull();

    const stale = await buildApp();
    await postLogin(stale.app, 'coordinator@example.invalid');
    stale.db.prepare('UPDATE login_tokens SET expires_at = ?').run(NOW);
    const calls: OutboundMail[] = [];
    expect(await deliverDueMail(stale.db, { send: async (message) => { calls.push(message); return { result: 'sent', providerId: null }; } }, NOW, () => 0.5)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stale.db.prepare("SELECT status AS status FROM outbox WHERE kind = 'magic_link'").get()).toEqual({ status: 'cancelled' });
  });

  it('escapes the sign-in letter', () => {
    const rendered = renderMagicLink({ signInUrl: 'http://127.0.0.1:3000/login/link/abc', replyTo: 'a<b@example.invalid' });
    expect(rendered.html).toContain('a&lt;b@example.invalid');
    expect(rendered.html).not.toContain('a<b@example.invalid');
    expect(rendered.subject).not.toContain('\n');
  });

  it('sets the session cookie for https and for a mounted path', () => {
    const secure = sessionSetCookie({ basePath: '/volunteer', secureCookies: true }, 'abc');
    expect(secure).toContain('Path=/volunteer');
    expect(secure).toContain('Secure');
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(sessionSetCookie({ basePath: '', secureCookies: false }, 'abc')).not.toContain('Secure');
    expect(sessionClearCookie({ basePath: '', secureCookies: false })).toContain('Max-Age=0');
  });
});

describe('coordinator screens', () => {
  it('shows the next two weeks of shifts above equal event and download cells', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const eventId = await createEvent(app, cookie, 'Weekly pantry', true);
    const hiddenId = await createEvent(app, cookie, 'Holiday food drive', false);
    const todayId = await addShift(app, cookie, eventId, { role: 'Pantry helper', date: '2026-10-14', capacity: '6', start: '16:00', end: '18:00' });
    const laterId = await addShift(app, cookie, eventId, { role: 'Pantry helper', date: '2026-10-27', capacity: '6', start: '16:00', end: '18:00' });
    const fullId = await addShift(app, cookie, eventId, { role: 'Sorting crew', date: '2026-10-24', capacity: '1', start: '09:00', end: '11:00' });
    await addShift(app, cookie, eventId, { role: 'Edge shift', date: '2026-10-28', capacity: '2' });
    await addShift(app, cookie, eventId, { role: 'Later shift', date: '2026-10-29', capacity: '2' });
    await addShift(app, cookie, hiddenId, { role: 'Packing', date: '2026-10-20', capacity: '3' });
    for (let index = 0; index < 4; index += 1) reserve(db, todayId, `Pat ${index}`, `pat${index}@example.invalid`, `home-open-${index}`);
    reserve(db, laterId, 'Ada One', 'ada1@example.invalid', 'home-later-1');
    reserve(db, laterId, 'Ada Two', 'ada2@example.invalid', 'home-later-2');
    reserve(db, fullId, 'Full Person', 'full@example.invalid', 'home-full');

    const html = await (await app.request('/admin', { headers: { cookie } })).text();
    expect(html).toContain('Wednesday, October 14, 2026');
    expect(html).toContain('Shifts that need volunteers');
    expect(html).toContain('Next 2 weeks');
    expect(html).toContain('Today, 4:00 PM');
    expect(html).toContain('2 open · 4 of 6');
    expect(html).toContain('Tue, Oct 27, 4:00 PM');
    expect(html).toContain('Needs 4 · 2 of 6');
    expect(html).toContain('Sat, Oct 24 Sorting crew is full.');
    expect(html).toContain('Wed, Oct 28, 9:00 AM');
    expect(html).not.toContain('Later shift');
    expect(html).toContain('class="desk-split"');
    expect(html).toContain('Next shift today at 4:00 PM · 5 shifts');
    expect(html).toContain('>Public<');
    expect(html).toContain('>Hidden<');
    expect(html).toContain('Next shift Tue, Oct 20 at 9:00 AM · 1 shift');
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('value="2026-10-31"');
    expect(html).toContain('Download spreadsheet');
    expect(html).toContain('href="/admin/contacts"');
  });

  it('keeps unpublished events and the roster off the public site', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    expect((await app.request('/admin')).status).toBe(303);

    const created = await postForm(app, '/admin/events', cookie, {
      title: 'Soup Night',
      slug: '',
      description: 'Bring a spoon.',
      location: 'Sioux Center, Iowa',
      tz: 'America/Chicago',
    }, { origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(created.status).toBe(303);
    const eventId = Number(/\/admin\/events\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1]);
    expect((await app.request('/e/soup-night')).status).toBe(404);
    expect(await (await app.request('/')).text()).not.toContain('Soup Night');

    const published = await postForm(app, `/admin/events/${eventId}`, cookie, {
      title: 'Soup Night',
      slug: 'soup-night',
      description: 'Bring a spoon.',
      location: 'Sioux Center, Iowa',
      tz: 'America/Chicago',
      published: 'yes',
    });
    expect(published.status).toBe(303);
    expect((await app.request('/e/soup-night')).status).toBe(200);

    const shift = await postForm(app, `/admin/events/${eventId}/shifts`, cookie, {
      role: 'Ladle',
      date: '2026-10-15',
      start: '09:00',
      end: '12:00',
      capacity: '2',
    });
    expect(shift.status).toBe(303);
    const shiftId = Number(/\/admin\/shifts\/(\d+)/.exec(shift.headers.get('location') ?? '')?.[1]);
    const backwards = await postForm(app, `/admin/events/${eventId}/shifts`, cookie, {
      role: 'Overnight',
      date: '2026-10-15',
      start: '12:00',
      end: '09:00',
      capacity: '1',
    });
    expect(backwards.status).toBe(400);
    expect(await backwards.text()).toContain('same day');
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(1);

    const pat = reserve(db, shiftId, 'Pat Example', 'pat@example.invalid', 'pat-operation');
    const sam = reserve(db, shiftId, 'Sam Example', 'sam@example.invalid', 'sam-operation');
    expect(pat.manageToken).toBeTruthy();
    const roster = await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } });
    const rosterHtml = await roster.text();
    expect(rosterHtml).toContain('pat@example.invalid');
    expect(rosterHtml).toContain('Sam Example');
    expect(rosterHtml).toContain('Edit details');
    expect(rosterHtml).toContain('class="event-edit"');
    const publicShift = await (await app.request(`/s/${shiftId}`)).text();
    expect(publicShift).not.toContain('pat@example.invalid');
    expect(publicShift).not.toContain('Sam Example');
    expect(await (await app.request('/')).text()).not.toContain('pat@example.invalid');

    const tooSmall = await postForm(app, `/admin/shifts/${shiftId}`, cookie, {
      role: 'Ladle',
      date: '2026-10-15',
      start: '09:00',
      end: '12:00',
      capacity: '1',
    });
    expect(tooSmall.status).toBe(400);
    expect(await tooSmall.text()).toContain('cannot be lower');
    expect(db.prepare('SELECT capacity AS capacity FROM shifts WHERE id = ?').get(shiftId)).toEqual({ capacity: 2 });

    const moved = await postForm(app, `/admin/shifts/${shiftId}`, cookie, {
      role: 'Ladle',
      date: '2026-10-15',
      start: '10:00',
      end: '12:00',
      capacity: '2',
    });
    expect(moved.status).toBe(303);
    expect(readManageSignup(db, pat.manageToken ?? '', NOW)).toBeNull();
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'changed' AND status = 'pending'")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND status = 'pending'")).toBe(0);
    const changed = db.prepare("SELECT body_text AS body_text FROM outbox WHERE kind = 'changed' AND to_email = 'pat@example.invalid'").get() as { body_text: string };
    const nextToken = /\/m\/([A-Za-z0-9_-]+)/.exec(changed.body_text)?.[1] ?? '';
    expect(readManageSignup(db, nextToken, NOW)?.status).toBe('confirmed');
    expect(await (await app.request(`/s/${shiftId}`)).text()).toContain('10:00 AM');

    const patId = db.prepare("SELECT id AS id FROM signups WHERE email_norm = 'pat@example.invalid'").get() as { id: number };
    const cancelled = await postForm(app, `/admin/signups/${patId.id}/cancel`, cookie, {});
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get('location')).toContain('signup-cancelled');
    expect(db.prepare("SELECT status AS status FROM signups WHERE id = ?").get(patId.id)).toEqual({ status: 'cancelled' });
    expect(await (await app.request(`/s/${shiftId}`)).text()).not.toContain('pat@example.invalid');
    expect(await (await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } })).text()).toContain('Pat Example');

    const closed = await postForm(app, `/admin/shifts/${shiftId}/cancel`, cookie, {});
    expect(closed.status).toBe(303);
    expect(db.prepare('SELECT cancelled AS cancelled FROM shifts WHERE id = ?').get(shiftId)).toEqual({ cancelled: 1 });
    expect(db.prepare("SELECT status AS status FROM signups WHERE email_norm = 'sam@example.invalid'").get()).toEqual({ status: 'cancelled' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(2);
    expect(await (await app.request('/')).text()).not.toContain('Ladle');
    const closedAdmin = await (await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } })).text();
    expect(closedAdmin).toContain('Cancelled. The roster stays until you remove it.');
    expect(closedAdmin).not.toContain('Edit details');
    expect(closedAdmin).toContain('Remove this shift');
    const closedPage = await (await app.request(`/s/${shiftId}`)).text();
    expect(closedPage).toContain('This shift is closed');
    expect(closedPage).not.toContain('<form');
    expect(closedPage).not.toContain('sam@example.invalid');
    expect(auditJson(db)).not.toContain('@');
    expect(sam.manageToken).not.toBe(nextToken);
  });

  it('adds a walk-in without putting their name on the public list', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const shiftId = await openShift(app, cookie, { published: false, capacity: '2', role: 'Bagging', date: '2026-10-21' });
    const page = await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Add a walk-in');
    expect(html).toContain('src="/js/enhance.js?v=');
    expect(html).not.toContain('data-under-18');
    expect(html).not.toContain('data-guardian');
    expect(html).not.toContain('They are under 18');
    expect(html).not.toContain('cf-turnstile');
    const body = walkInBody(html, {
      name: 'Dee Example',
      email: 'Dee@Example.invalid',
      phone: '712-555-0199',
      notes: 'Arrived at the door',
    });
    const added = await postBody(app, `/admin/shifts/${shiftId}/walk-in`, cookie, body);
    const replay = await postBody(app, `/admin/shifts/${shiftId}/walk-in`, cookie, body);
    expect(added.status).toBe(303);
    expect(added.headers.get('location')).toContain('notice=walk-in');
    expect(replay.status).toBe(303);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'dee@example.invalid' AND status = 'confirmed' AND group_size = 1")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND status = 'pending' AND to_email = 'dee@example.invalid'")).toBe(1);
    expect(db.prepare("SELECT action AS action FROM audit WHERE action = 'signup.walkin'").get()).toEqual({ action: 'signup.walkin' });
    expect(auditJson(db)).not.toContain('@');
    const roster = await (await app.request(added.headers.get('location') ?? '', { headers: { cookie } })).text();
    expect(roster).toContain('They are on this shift');
    expect(roster).toContain('Dee Example');
    expect(await (await app.request('/')).text()).not.toContain('Dee Example');
    expect(await (await app.request('/')).text()).not.toContain('dee@example.invalid');
    expect((await app.request(`/s/${shiftId}`)).status).toBe(404);

    const again = await postWalkIn(app, cookie, shiftId, { name: 'Dee Example', email: 'dee@example.invalid' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('already signed up');
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(1);

    const other = await postWalkIn(app, cookie, shiftId, { name: 'Sam Example', email: 'dee@example.invalid' });
    expect(other.status).toBe(303);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'dee@example.invalid' AND status = 'confirmed'")).toBe(2);
  });

  it('keeps a walk-in off a full, closed, or ended shift', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const shiftId = await openShift(app, cookie, { published: true, capacity: '1', role: 'Sorting', date: '2026-10-21' });
    const added = await postWalkIn(app, cookie, shiftId, {
      name: 'Kim Example',
      email: 'kim@example.invalid',
    });
    expect(added.status).toBe(303);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND status = 'pending'")).toBe(1);
    const full = await (await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } })).text();
    expect(full).toContain('This shift is full.');
    expect(full).not.toContain('Add a walk-in');
    expect(await (await app.request(`/s/${shiftId}`)).text()).not.toContain('kim@example.invalid');
    const overflow = await postWalkIn(app, cookie, shiftId, { name: 'More Example', email: 'more@example.invalid' });
    expect(overflow.status).toBe(400);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(1);

    const endedId = await openShift(app, cookie, { published: true, capacity: '2', role: 'Morning', date: '2026-10-14', start: '09:00', end: '12:00' });
    const ended = await (await app.request(`/admin/shifts/${endedId}`, { headers: { cookie } })).text();
    expect(ended).toContain('This shift has ended.');
    expect(ended).not.toContain('Add a walk-in');

    await postForm(app, `/admin/shifts/${shiftId}/cancel`, cookie, {});
    const closed = await (await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } })).text();
    expect(closed).not.toContain('Add a walk-in');
    const rejected = await app.request(`/admin/shifts/${shiftId}/walk-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: 'Late Example', email: 'late@example.invalid' }),
    });
    expect(rejected.status).toBe(403);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'late@example.invalid'")).toBe(0);
  });

  it('rejects a coordinator form without its matching token', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const rejected = await app.request('/admin/events', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ title: 'Nope', slug: 'nope', tz: 'America/Chicago' }),
    });
    expect(rejected.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM events')).toBe(0);
    const home = await app.request('/admin', { headers: { cookie } });
    const logout = await app.request('/logout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf: field(await home.text(), 'csrf') }),
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(303);
  });

  it('moves a confirmed signup onto another shift in the same event', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const eventId = await createEvent(app, cookie, 'Pantry', true);
    const sourceId = await addShift(app, cookie, eventId, { role: 'Sorting', date: '2026-10-22', capacity: '2' });
    const destinationId = await addShift(app, cookie, eventId, { role: 'Distribution', date: '2026-10-23', capacity: '2' });
    const added = await postWalkIn(app, cookie, sourceId, {
      name: 'Kim Example',
      email: 'kim@example.invalid',
    });
    expect(added.status).toBe(303);
    const signupId = signupIdFor(db, 'kim@example.invalid');
    db.prepare('UPDATE signups SET phone = ?, notes = ?, reminders_off = 1 WHERE id = ?').run('712-555-0199', 'Blue shirt', signupId);
    const oldToken = manageToken(db, signupId, 'confirmation');
    db.prepare(
      `INSERT INTO outbox (
         dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
         headers_json, send_after, attempts, status, created_at
       ) VALUES (?, ?, ?, 'reminder', ?, 'Reminder', 'Soon', '<p>Soon</p>', '{}', ?, 0, 'pending', ?)`,
    ).run(`reminder:${signupId}`, signupId, sourceId, 'kim@example.invalid', NOW, NOW);
    const versions = shiftVersions(db);
    const page = await app.request(`/admin/shifts/${sourceId}`, { headers: { cookie } });
    const html = await page.text();
    expect(optionValues(html, 'destination')).toEqual([String(destinationId)]);
    expect(html).toContain('<optgroup label="Friday, October 23, 2026">');
    expect(html).toContain('>Distribution, October 23, 2026, 9:00 AM to 12:00 PM CDT<');
    const moved = await postMove(app, cookie, signupId, html, String(destinationId));
    expect(moved.status).toBe(303);
    expect(moved.headers.get('location')).toBe(`/admin/shifts/${destinationId}?notice=moved`);

    const source = db.prepare('SELECT status, shift_id FROM signups WHERE id = ?').get(signupId) as {
      status: string;
      shift_id: number;
    };
    expect(source).toEqual({ status: 'cancelled', shift_id: sourceId });
    expect(readManageSignup(db, oldToken, NOW)).toBeNull();
    const created = db.prepare(
      `SELECT id, status, phone, notes, reminders_off, is_minor, guardian_name, guardian_email, shift_id
       FROM signups WHERE shift_id = ? AND status = 'confirmed'`,
    ).get(destinationId) as {
      id: number;
      status: string;
      phone: string;
      notes: string;
      reminders_off: number;
      is_minor: number;
      guardian_name: string | null;
      guardian_email: string | null;
      shift_id: number;
    };
    expect(created).toMatchObject({
      status: 'confirmed',
      phone: '712-555-0199',
      notes: 'Blue shirt',
      reminders_off: 1,
      is_minor: 0,
      guardian_name: null,
      guardian_email: null,
      shift_id: destinationId,
    });
    expect(shiftVersions(db)).toEqual(versions);
    expect(counted(db, signupId, 'confirmation', 'cancelled')).toBe(1);
    expect(db.prepare("SELECT status AS status FROM outbox WHERE kind = 'reminder'").get()).toEqual({ status: 'cancelled' });
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'changed' AND status = 'pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'cancelled'")).toBe(0);
    const letter = db.prepare("SELECT subject, body_text FROM outbox WHERE kind = 'changed' AND to_email = 'kim@example.invalid'").get() as {
      subject: string;
      body_text: string;
    };
    expect(letter.subject).toBe('Your signup was moved to Distribution');
    expect(letter.body_text).toContain('A coordinator moved your signup to a different shift.');
    expect(letter.body_text).not.toContain(oldToken);
    const nextToken = manageToken(db, created.id, 'changed');
    expect(readManageSignup(db, nextToken, NOW)?.role).toBe('Distribution');
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'signup.move'")).toBe(1);

    const again = await postMove(app, cookie, signupId, html, String(destinationId));
    expect(again.status).toBe(303);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE status = 'confirmed'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'signup.move'")).toBe(1);
    const roster = await (await app.request(moved.headers.get('location') ?? '', { headers: { cookie } })).text();
    expect(roster).toContain('They are on this shift. A change email is queued.');
    expect(roster).toContain('Kim Example');
    expect(roster).not.toContain('No-show');
    const sourceRoster = await (await app.request(`/admin/shifts/${sourceId}`, { headers: { cookie } })).text();
    expect(sourceRoster).not.toContain(`/admin/signups/${signupId}/move`);
    expect(sourceRoster).toContain('0/2 spots filled');
    expect(sourceRoster).toContain('event-pill is-open');
    const home = await (await app.request('/e/pantry?view=calendar')).text();
    const shiftPage = await (await app.request(`/s/${destinationId}`)).text();
    expect(home).not.toContain('kim@example.invalid');
    expect(home).not.toContain('Blue shirt');
    expect(home).toContain('Kim Example');
    expect(shiftPage).not.toContain('kim@example.invalid');
    expect(auditJson(db)).not.toContain('@');
  });

  it('keeps the original signup when the move cannot be saved', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const eventId = await createEvent(app, cookie, 'Pantry', true);
    const sourceId = await addShift(app, cookie, eventId, { role: 'Sorting', date: '2026-10-22', capacity: '2' });
    const fullId = await addShift(app, cookie, eventId, { role: 'Full shift', date: '2026-10-23', capacity: '1' });
    const openId = await addShift(app, cookie, eventId, { role: 'Distribution', date: '2026-10-24', capacity: '2' });
    const endedId = await addShift(app, cookie, eventId, { role: 'Morning', date: '2026-10-14', capacity: '2', start: '09:00', end: '12:00' });
    const otherEvent = await createEvent(app, cookie, 'Other', true);
    const otherShift = await addShift(app, cookie, otherEvent, { role: 'Elsewhere', date: '2026-10-25', capacity: '2' });
    await postWalkIn(app, cookie, sourceId, { name: 'Ria Example', email: 'ria@example.invalid' });
    await postWalkIn(app, cookie, fullId, { name: 'Dee Example', email: 'dee@example.invalid' });
    const signupId = signupIdFor(db, 'ria@example.invalid');
    const page = await (await app.request(`/admin/shifts/${sourceId}`, { headers: { cookie } })).text();
    expect(optionValues(page, 'destination')).toEqual([String(openId)]);
    expect(page).not.toContain('Full shift,');
    expect(page).not.toContain('Morning,');
    const mailBefore = count(db, 'SELECT COUNT(*) AS n FROM outbox');

    const full = await postMove(app, cookie, signupId, page, String(fullId));
    expect(full.status).toBe(400);
    expect(await full.text()).toContain('That shift is full.');
    const ended = await postMove(app, cookie, signupId, page, String(endedId));
    expect(ended.status).toBe(400);
    expect(await ended.text()).toContain('That shift is closed.');
    const elsewhere = await postMove(app, cookie, signupId, page, String(otherShift));
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('Choose a shift in this event.');
    await postWalkIn(app, cookie, openId, { name: 'Ria Example', email: 'ria@example.invalid' });
    const duplicate = await postMove(app, cookie, signupId, page, String(openId));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain('That person is already signed up for this shift.');
    expect(db.prepare('SELECT status, shift_id FROM signups WHERE id = ?').get(signupId)).toEqual({ status: 'confirmed', shift_id: sourceId });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'signup.move'")).toBe(0);
    expect(counted(db, signupId, 'confirmation', 'pending')).toBe(1);

    const bare = await app.request(`/admin/signups/${signupId}/move`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ destination: String(openId) }),
    });
    expect(bare.status).toBe(403);
    expect(db.prepare('SELECT status FROM signups WHERE id = ?').get(signupId)).toEqual({ status: 'confirmed' });

    const stale = await postMove(app, cookie, signupId, page.replace(/name="move_token" value="[^"]*"/, 'name="move_token" value="nope"'), String(openId));
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('This form is out of date');
    await postForm(app, `/admin/signups/${signupId}/cancel`, cookie, {});
    const cancelled = await postMove(app, cookie, signupId, page, String(openId));
    expect(cancelled.status).toBe(400);
    expect(await cancelled.text()).toContain('That signup is cancelled.');
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ria@example.invalid' AND status = 'confirmed'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBeGreaterThan(mailBefore);
    expect(auditJson(db)).not.toContain('@');
  });

  it('moves someone onto a shift that already has their email for a different person', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const eventId = await createEvent(app, cookie, 'Pantry', true);
    const sourceId = await addShift(app, cookie, eventId, { role: 'Sorting', date: '2026-10-22', capacity: '2' });
    const openId = await addShift(app, cookie, eventId, { role: 'Distribution', date: '2026-10-24', capacity: '2' });
    await postWalkIn(app, cookie, sourceId, { name: 'Ria Example', email: 'ria@example.invalid' });
    await postWalkIn(app, cookie, openId, { name: 'Sam Example', email: 'ria@example.invalid' });
    const signupId = signupIdFor(db, 'ria@example.invalid');
    const page = await (await app.request(`/admin/shifts/${sourceId}`, { headers: { cookie } })).text();
    const moved = await postMove(app, cookie, signupId, page, String(openId));
    expect(moved.status).toBe(303);
    expect(count(db, `SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ria@example.invalid' AND shift_id = ${openId} AND status = 'confirmed'`)).toBe(2);
    expect(db.prepare('SELECT status, shift_id FROM signups WHERE id = ?').get(signupId)).toEqual({ status: 'cancelled', shift_id: sourceId });
  });

  it('keeps the next two weeks of shifts in view and tucks later ones under see more', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const eventId = await createEvent(app, cookie, 'Pantry', true);
    await addShift(app, cookie, eventId, { role: 'Morning', date: '2026-10-13', capacity: '2' });
    await addShift(app, cookie, eventId, { role: 'Sorting', date: '2026-10-15', capacity: '2' });
    await addShift(app, cookie, eventId, { role: 'Distribution', date: '2026-10-28', capacity: '2' });
    await addShift(app, cookie, eventId, { role: 'Intake', date: '2026-11-04', capacity: '2' });
    await addShift(app, cookie, eventId, { role: 'Packing', date: '2026-11-11', capacity: '2' });
    const eveningId = await addShift(app, cookie, eventId, { role: 'Evening', date: '2026-11-18', capacity: '2' });
    expect((await postForm(app, `/admin/shifts/${eveningId}/cancel`, cookie, {})).status).toBe(303);

    const html = await (await app.request(`/admin/events/${eventId}`, { headers: { cookie } })).text();
    const moreAt = html.indexOf('Show 2 more shifts');
    expect(moreAt).toBeGreaterThan(0);
    const before = html.slice(0, moreAt);
    const after = html.slice(moreAt);
    expect(before).toContain('Morning');
    expect(before).toContain('Sorting');
    expect(before).toContain('Distribution');
    expect(before).not.toContain('Intake');
    expect(before).not.toContain('Packing');
    expect(before).not.toContain('Evening');
    expect(after.indexOf('Intake')).toBeGreaterThan(-1);
    expect(after.indexOf('Packing')).toBeGreaterThan(after.indexOf('Intake'));
    expect(after.indexOf('Evening')).toBeGreaterThan(after.indexOf('Packing'));
    expect(after).toContain('Show fewer');
    expect(html).not.toContain('<details class="shift-more" open');
    expect(count(db, 'SELECT COUNT(*) AS n FROM shifts')).toBe(6);

    const soon = await createEvent(app, cookie, 'Soup', true);
    await addShift(app, cookie, soon, { role: 'Ladle', date: '2026-10-16', capacity: '2' });
    const short = await (await app.request(`/admin/events/${soon}`, { headers: { cookie } })).text();
    expect(short).toContain('Ladle');
    expect(short).not.toContain('Show 1 more shift');
    expect(short).not.toContain('shift-more');

    const distant = await createEvent(app, cookie, 'Holiday', true);
    await addShift(app, cookie, distant, { role: 'Early', date: '2026-11-04', capacity: '2' });
    await addShift(app, cookie, distant, { role: 'Later', date: '2026-11-18', capacity: '2' });
    const far = await (await app.request(`/admin/events/${distant}`, { headers: { cookie } })).text();
    const farMore = far.indexOf('Show 1 more shift');
    expect(farMore).toBeGreaterThan(0);
    expect(far.slice(0, farMore)).toContain('Early');
    expect(far.slice(farMore)).toContain('Later');
  });

  it('treats an expired session as signed out', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    db.prepare('UPDATE sessions SET expires_at = ?').run(NOW);
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(303);
  });
});

const LINK_GONE = 'This sign-in link is not available.';

async function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-admin-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  const created = bootstrapAdmin(db, config.bootstrapAdminEmail, NOW);
  const app = createApp(config, db, {
    now: NOW,
    clientIp: () => '203.0.113.10',
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db, config, created };
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

async function postForm(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  pathname: string,
  cookie: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
) {
  const current = await app.request('/admin', { headers: { cookie } });
  const csrf = field(await current.text(), 'csrf');
  return app.request(pathname, {
    method: 'POST',
    headers: {
      origin: extraHeaders.origin ?? ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      ...extraHeaders,
    },
    body: new URLSearchParams({ csrf, ...fields }),
  });
}

function reserve(db: Awaited<ReturnType<typeof buildApp>>['db'], shiftId: number, name: string, email: string, operationId: string) {
  const result = reserveSignup(db, {
    shiftId,
    name,
    email,
    phone: '712-555-0100',
    notes: 'Bring gloves',
    operationId,
    now: NOW,
    mail: MAIL,
  });
  if (!result.ok || !result.manageToken) throw new Error('Reservation did not save.');
  return result;
}

function magicToken(db: Awaited<ReturnType<typeof buildApp>>['db']): string {
  const row = db
    .prepare("SELECT body_text AS body_text FROM outbox WHERE kind = 'magic_link' AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get() as { body_text: string } | undefined;
  const token = /\/login\/link\/([A-Za-z0-9_-]+)/.exec(row?.body_text ?? '')?.[1];
  if (!token) throw new Error('The sign-in link was not queued.');
  return token;
}

function usedAt(db: Awaited<ReturnType<typeof buildApp>>['db'], token: string): string | null {
  const row = db.prepare('SELECT used_at AS used_at FROM login_tokens WHERE token_hash = ?').get(sha256(token)) as { used_at: string | null };
  return row.used_at;
}

function cookieHeader(response: Response): string {
  const match = /hope_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
  if (!match?.[1]) throw new Error('The session cookie was not set.');
  return `hope_session=${match[1]}`;
}

async function createEvent(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  title: string,
  published: boolean,
) {
  const created = await postForm(app, '/admin/events', cookie, {
    title,
    slug: '',
    description: '',
    location: 'Sioux Center, Iowa',
    tz: 'America/Chicago',
    ...(published ? { published: 'yes' } : {}),
  });
  return Number(/\/admin\/events\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1]);
}

async function addShift(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  eventId: number,
  input: { role: string; date: string; capacity: string; start?: string; end?: string },
) {
  const shift = await postForm(app, `/admin/events/${eventId}/shifts`, cookie, {
    role: input.role,
    date: input.date,
    start: input.start ?? '09:00',
    end: input.end ?? '12:00',
    capacity: input.capacity,
  });
  return Number(/\/admin\/shifts\/(\d+)/.exec(shift.headers.get('location') ?? '')?.[1]);
}

function postMove(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  signupId: number,
  html: string,
  destination: string,
) {
  return postBody(
    app,
    `/admin/signups/${signupId}/move`,
    cookie,
    new URLSearchParams({
      csrf: field(html, 'csrf'),
      move_token: field(html, 'move_token'),
      destination,
    }),
  );
}

function optionValues(html: string, name: string): string[] {
  const select = new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
  return [...select.matchAll(/value="(\d+)"/g)].map((match) => match[1] ?? '');
}

function signupIdFor(db: Awaited<ReturnType<typeof buildApp>>['db'], email: string): number {
  return Number((db.prepare('SELECT id AS id FROM signups WHERE email_norm = ? ORDER BY id LIMIT 1').get(email) as { id: number }).id);
}

function manageToken(db: Awaited<ReturnType<typeof buildApp>>['db'], signupId: number, kind: string): string {
  const row = db.prepare('SELECT body_text AS body_text FROM outbox WHERE signup_id = ? AND kind = ? LIMIT 1').get(signupId, kind) as {
    body_text: string;
  };
  const token = /\/m\/([A-Za-z0-9_-]+)/.exec(row.body_text)?.[1];
  if (!token) throw new Error('The manage link was not queued.');
  return token;
}

function shiftVersions(db: Awaited<ReturnType<typeof buildApp>>['db']): Array<{ id: number; version: number }> {
  return db.prepare('SELECT id AS id, version AS version FROM shifts ORDER BY id').all() as Array<{ id: number; version: number }>;
}

function counted(db: Awaited<ReturnType<typeof buildApp>>['db'], signupId: number, kind: string, status: string): number {
  return Number(
    (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE signup_id = ? AND kind = ? AND status = ?').get(signupId, kind, status) as { n: number }).n,
  );
}

async function openShift(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  input: { published: boolean; capacity: string; role: string; date: string; start?: string; end?: string },
) {
  const created = await postForm(app, '/admin/events', cookie, {
    title: input.role,
    slug: '',
    description: '',
    location: 'Sioux Center, Iowa',
    tz: 'America/Chicago',
    ...(input.published ? { published: 'yes' } : {}),
  });
  const eventId = Number(/\/admin\/events\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1]);
  const shift = await postForm(app, `/admin/events/${eventId}/shifts`, cookie, {
    role: input.role,
    date: input.date,
    start: input.start ?? '09:00',
    end: input.end ?? '12:00',
    capacity: input.capacity,
  });
  return Number(/\/admin\/shifts\/(\d+)/.exec(shift.headers.get('location') ?? '')?.[1]);
}

async function postWalkIn(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  shiftId: number,
  fields: Record<string, string>,
) {
  const page = await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } });
  return postBody(app, `/admin/shifts/${shiftId}/walk-in`, cookie, walkInBody(await page.text(), fields));
}

function walkInBody(html: string, fields: Record<string, string>) {
  return new URLSearchParams({
    csrf: field(html, 'csrf'),
    form_token: field(html, 'form_token'),
    name: fields.name ?? '',
    email: fields.email ?? '',
    phone: fields.phone ?? '712-555-0100',
    notes: fields.notes ?? '',
  });
}

function postBody(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  pathname: string,
  cookie: string,
  body: URLSearchParams,
) {
  return app.request(pathname, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
