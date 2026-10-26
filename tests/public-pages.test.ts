import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, publicDirectory } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { Hono } from 'hono';
import { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, securityHeaders, STRICT_TRANSPORT_SECURITY } from '../src/security.js';
import { localShiftToUtc } from '../src/time.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('public pages', () => {
  it('lists upcoming published shifts and hides private details', async () => {
    const { app, ids } = await buildApp();
    const home = await app.request('/');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Weekly pantry');
    expect(html).not.toContain('Upcoming shifts');
    expect(html).toContain('Open Sorting');
    expect(html).toContain('Full Intake');
    expect(html).toContain('Live Greeting');
    expect(html).toContain('1/3 spots filled');
    expect(html).toContain('1/1 spots filled');
    expect(html).toContain('9:00 AM');
    expect(html).toContain('CDT');
    expect(html).toContain('October 15');
    expect(html).toContain('October 2026');
    expect(html).toContain('shift-calendar');
    expect(html).toContain('class="cal-line"');
    expect(html).toContain('class="cal-hold"');
    expect(html).toContain('class="cal-detail"');
    expect(html).toContain('>Sun</span>');
    expect(html).toContain('Today');
    expect(html).toContain('aria-current="date"');
    expect(html).toContain('In progress');
    expect(html).not.toContain('Volunteer tools');
    const header = html.slice(html.indexOf('class="header"'), html.indexOf('<main'));
    expect(header).toContain('class="main-nav-link" href="/" aria-current="page">Volunteering</a>');
    expect(header).toContain('href="https://hopefoodpantrysc.org/"');
    expect(header).toContain('href="https://hopefoodpantrysc.org/about"');
    expect(header).toContain('href="https://hopefoodpantrysc.org/faq"');
    expect(header).toContain('href="https://hopefoodpantrysc.org/#contact"');
    expect(header).toContain('https://donorbox.org/hope-food-pantry-1');
    expect(header).not.toContain('Coordinator');
    expect(header).not.toContain('>Privacy</a>');
    expect(header).not.toContain('Calendar');
    expect(header).not.toContain('Log out');
    const nav = html.slice(html.indexOf('class="nav-links"'), html.indexOf('</ul>'));
    expect(nav).toContain('Donate');
    expect(nav).not.toContain('Coordinator');
    expect(nav).not.toContain('Privacy');
    expect(nav).not.toContain('Log out');
    const footer = html.slice(html.indexOf('class="footer"'));
    expect(footer).toContain('equal opportunity provider');
    expect(footer).toContain('Cosmically Creative');
    expect(footer).toContain('712\u2011540\u20119351');
    expect(footer).toContain('class="main-nav-link" href="/" aria-current="page">Volunteering</a>');
    expect(footer).not.toContain('Privacy');
    expect(footer).not.toContain('Coordinator');
    expect(html).not.toContain('Cancelled Distribution');
    expect(html).not.toContain('Past Setup');
    expect(html).not.toContain('Hidden draft');
    expect(html).not.toContain('Secret Person');
    expect(html).not.toContain('secret.person@example.invalid');
    expect(html).not.toContain('SECRET-PERSON-NOTE');
    expect(html).not.toContain('SECRET-SHIFT-NOTE');
    expect(html).not.toContain('<form');
    expect(html).toContain('src="/js/desk.js?v=');
    expect(html).toContain('src="/js/enhance.js?v=');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('href="/css/app.css?v=');
    expect(html).toContain('href="/brand/tokens.css?v=');
    expect(html).toContain(`href="/s/${ids.open}"`);
    expect(home.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(home.headers.get('referrer-policy')).toBe('no-referrer');
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    expect(home.headers.get('strict-transport-security')).toBeNull();
    expect(home.headers.get('cache-control')).toBe('no-store');

    const event = await app.request('/e/weekly-pantry');
    const eventHtml = await event.text();
    expect(event.status).toBe(200);
    expect(eventHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(eventHtml).not.toContain('<script>alert(1)</script>');
    expect(eventHtml).toContain('Sioux Center, Iowa');
    expect(eventHtml).toContain('October 2026');
    expect(eventHtml).toContain('shift-calendar');
    expect(eventHtml).toContain('Sign up');
    expect(eventHtml).toContain('View shift');
    expect(eventHtml).not.toContain('November 2026');
    expect(eventHtml).not.toContain('SECRET-PERSON-NOTE');

    const shift = await app.request(`/s/${ids.open}`);
    const shiftHtml = await shift.text();
    expect(shift.status).toBe(200);
    expect(shiftHtml).toContain('Open Sorting');
    expect(shiftHtml).not.toContain('class="crumb"');
    const shiftMain = shiftHtml.slice(shiftHtml.indexOf('<main'), shiftHtml.indexOf('class="footer"'));
    expect(shiftMain).not.toContain('Weekly pantry');
    expect(shiftMain).not.toContain('sunburst');
    expect(shiftHtml).toContain('1/3 spots filled');
    expect(shiftHtml).toContain('spots is-open');
    expect(shiftHtml).toContain('<form');
    expect(shiftHtml).toContain('name="first_name"');
    expect(shiftHtml).toContain('name="last_name"');
    expect(shiftHtml).toContain('First name');
    expect(shiftHtml).toContain('Last name');
    expect(shiftHtml).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(shiftHtml).not.toContain('data-under-18');
    expect(shiftHtml).not.toContain('data-guardian');
    expect(shiftHtml).not.toContain('I am under 18');
    const css = await (await app.request('/css/app.css')).text();
    expect(css).not.toContain('data-under-18');
    expect(css).not.toContain('data-guardian');
    expect(shiftHtml).not.toContain('SECRET-SHIFT-NOTE');
    expect(shiftHtml).not.toContain('Secret Person');

    const full = await app.request(`/s/${ids.full}`);
    const fullHtml = await full.text();
    expect(fullHtml).toContain('1/1 spots filled');
    expect(fullHtml).toContain('spots is-full');
    expect(fullHtml).not.toContain('<form');

    const cancelled = await app.request(`/s/${ids.cancelled}`);
    const cancelledHtml = await cancelled.text();
    expect(cancelled.status).toBe(200);
    expect(cancelledHtml).toContain('Cancelled. This shift is closed.');
    expect(cancelledHtml).not.toContain('<form');

    const past = await app.request(`/s/${ids.past}`);
    const pastHtml = await past.text();
    expect(pastHtml).toContain('Ended. This shift is closed.');
    expect(pastHtml).not.toContain('<form');

    const live = await app.request(`/s/${ids.live}`);
    expect(await live.text()).toContain('In progress');

    expect((await app.request('/e/hidden-draft')).status).toBe(404);
    expect((await app.request(`/s/${ids.hidden}`)).status).toBe(404);
    expect((await app.request('/e/missing')).status).toBe(404);
    expect((await app.request('/s/nope')).status).toBe(404);
  });

  it('leaves the event name and sunburst off shift pages', async () => {
    const { app, ids } = await buildApp();
    const shiftHtml = await (await app.request(`/s/${ids.open}`)).text();
    const shiftMain = shiftHtml.slice(shiftHtml.indexOf('<main'), shiftHtml.indexOf('class="footer"'));
    expect(shiftMain).toContain('Open Sorting');
    expect(shiftMain).not.toContain('class="crumb"');
    expect(shiftMain).not.toContain('Weekly pantry');
    expect(shiftMain).not.toContain('sunburst');
    const stylesheet = await (await app.request('/css/app.css')).text();
    expect(stylesheet).not.toContain('sunburst');
    expect(stylesheet).not.toContain('h1.bare');
  });

  it('serves an honest privacy page, a minimal health check, and static assets', async () => {
    const { app } = await buildApp();
    const privacy = await app.request('/privacy');
    const privacyHtml = await privacy.text();
    expect(privacy.status).toBe(200);
    expect(privacyHtml).toContain('class="main-nav-link" href="/">Volunteering</a>');
    expect(privacyHtml).not.toContain('aria-current="page"');
    expect(privacyHtml).toContain('does not have an approved privacy notice yet');
    expect(privacyHtml).toContain('This page is not a privacy policy.');
    expect(privacyHtml).not.toContain('24 months');

    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toEqual({ ok: true, database: 'ok' });
    expect(JSON.stringify(healthBody)).not.toMatch(/session|turnstile|secret|@/i);

    const css = await app.request('/css/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('public, max-age=3600');
    const stylesheet = await css.text();
    expect(stylesheet).toContain('var(--hope-ink)');
    expect(stylesheet).toContain('@view-transition');
    expect(stylesheet).toContain('view-transition-name: site-header');
    expect(stylesheet).toMatch(/lexend-latin\.woff2\?v=/);
    expect(stylesheet).not.toContain('sunburst');
    const tokens = await app.request('/brand/tokens.css');
    expect(tokens.status).toBe(200);
    expect(await tokens.text()).toContain('--hope-yellow:#f9e194');

    const home = await app.request('/');
    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(home.headers.get('speculation-rules')).toBe('"/speculation-rules.json"');
    const homeHtml = await home.text();
    const styled = versionedAsset(homeHtml, '/css/app.css');
    const versioned = await app.request(styled);
    expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const font = stylesheet.match(/(\/brand\/fonts\/lexend-latin\.woff2\?v=[A-Za-z0-9_-]+)/);
    const fontFile = await app.request(font?.[1] ?? '/missing');
    expect(fontFile.status).toBe(200);
    expect(fontFile.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await fontFile.arrayBuffer()).length).toBeGreaterThan(1000);
    const logo = await app.request(versionedAsset(homeHtml, '/img/logo.png'));
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toContain('image/png');
    const logoBytes = Buffer.from(await logo.arrayBuffer());
    expect(logoBytes.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(logoBytes.length).toBeGreaterThan(1000);
    const script = await app.request(versionedAsset(homeHtml, '/js/desk.js'));
    expect(script.status).toBe(200);
    expect((await script.text()).length).toBeGreaterThan(20);

    const rules = await app.request('/speculation-rules.json');
    expect(rules.status).toBe(200);
    expect(rules.headers.get('content-type')).toContain('application/speculationrules+json');
    const body = await rules.json();
    expect(body.prefetch[0].eagerness).toBe('moderate');
    expect(body.prefetch[0].where.and[1].not.selector_matches).toContain('[data-confirm]');
    expect(body.prefetch[0].where.and[1].not.selector_matches).toContain('[data-open-event]');
  });

  it('prefixes routes and assets when the app is mounted at /volunteer', async () => {
    const { app } = await buildApp({ basePath: '/volunteer' });
    expect((await app.request('/')).status).toBe(404);
    expect((await app.request('/healthz')).status).toBe(404);
    const home = await app.request('/volunteer');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('href="/volunteer/css/app.css?v=');
    expect(html).toContain('href="/volunteer/brand/tokens.css?v=');
    expect(home.headers.get('speculation-rules')).toBe('"/volunteer/speculation-rules.json"');
    expect(html).toContain('Weekly pantry');
    expect(html).not.toContain('Upcoming shifts');
    expect((await app.request('/volunteer/e/weekly-pantry')).status).toBe(200);
    expect(html).toContain('class="main-nav-link" href="/volunteer" aria-current="page">Volunteering</a>');
    expect(html).toMatch(/href="\/volunteer\/s\/\d+"/);
    const slash = await app.request('/volunteer/');
    expect(slash.status).toBe(302);
    expect(slash.headers.get('location')).toBe('/volunteer');
    const css = await app.request('/volunteer/css/app.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('var(--font-body)');
    const health = await app.request('/volunteer/healthz');
    expect(await health.json()).toEqual({ ok: true, database: 'ok' });
  });

  it('shows one month at a time and cycles between months that have shifts', async () => {
    const { app, db } = await buildApp();
    const event = db.prepare(`SELECT id AS id FROM events WHERE slug = 'weekly-pantry'`).get() as { id: number };
    insertShift(db, event.id, 'November Sorting', '2026-11-04', '09:00', '12:00', 4, 0);
    insertShift(db, event.id, 'Edge Sorting', '2026-11-30', '09:00', '12:00', 4, 0);
    insertShift(db, event.id, 'December Sorting', '2026-12-02', '09:00', '12:00', 4, 0);
    const html = await (await app.request('/e/weekly-pantry')).text();
    const home = await (await app.request('/')).text();
    expect(html).toContain('October 2026');
    expect(html).toContain('Next month');
    expect(html).not.toContain('Previous month');
    expect(html).not.toContain('November 2026');
    expect(html).not.toContain('September');
    expect(home).toContain('href="/?month=2026-11"');
    expect(home).toContain('Next month');
    expect(html).toContain('Open Sorting');
    expect(html).not.toContain('November Sorting');
    expect(html).toContain('href="/e/weekly-pantry?month=2026-11"');
    expect(html.match(/class="cal-title"/g)).toHaveLength(1);

    const november = await (await app.request('/e/weekly-pantry?month=2026-11')).text();
    expect(november).toContain('November 2026');
    expect(november).toContain('November Sorting');
    expect(november).not.toContain('Open Sorting');
    expect(november).toContain('Previous month');
    expect(november).toContain('Next month');
    expect(november).toContain('href="/e/weekly-pantry?month=2026-10"');
    expect(november).toContain('href="/e/weekly-pantry?month=2026-12"');
    expect(november.match(/class="role">Edge Sorting/g)).toHaveLength(1);

    const december = await (await app.request('/e/weekly-pantry?month=2026-12')).text();
    expect(december).toContain('December Sorting');
    expect(december).toContain('Previous month');
    expect(december).not.toContain('Next month');
    expect(december).not.toContain('November Sorting');

    const invalid = await (await app.request('/e/weekly-pantry?month=nope')).text();
    expect(invalid).toContain('October 2026');
    expect(invalid).toContain('Open Sorting');
  });

  it('shows an empty list when nothing is upcoming', async () => {
    const { app } = await buildApp({ empty: true });
    const html = await (await app.request('/')).text();
    expect(html).toContain('No upcoming shifts are posted.');
  });
});

async function buildApp(options?: { basePath?: string; empty?: boolean }) {
  const dataDir = path.join(mkdtempSync(path.join(tmpdir(), 'hope-volunteer-')), 'data');
  dirs.push(path.dirname(dataDir));
  const config = loadConfig(
    devEnv({
      DATA_DIR: dataDir,
      BASE_PATH: options?.basePath ?? '',
    }),
  );
  const db = await openAppDatabase(config);
  databases.push(db);
  const ids = options?.empty ? emptyIds() : seedCatalog(db);
  const app = createApp(config, db, { now: NOW, publicDir: publicDirectory() });
  return { app, ids, db, close: () => db.close() };
}

function emptyIds() {
  return { open: 0, full: 0, cancelled: 0, past: 0, live: 0, hidden: 0 };
}

function seedCatalog(db: import('better-sqlite3').Database) {
  const event = insertEvent(db, {
    slug: 'weekly-pantry',
    title: 'Weekly pantry',
    description: 'Bring a hat.\n<script>alert(1)</script>',
    published: 1,
  });
  const hidden = insertEvent(db, {
    slug: 'hidden-draft',
    title: 'Hidden draft',
    description: '',
    published: 0,
  });
  const open = insertShift(db, event, 'Open Sorting', '2026-10-15', '09:00', '12:00', 3, 0);
  insertSignup(db, open);
  const full = insertShift(db, event, 'Full Intake', '2026-10-16', '09:00', '12:00', 1, 0);
  insertSignup(db, full);
  const cancelled = insertShift(db, event, 'Cancelled Distribution', '2026-10-17', '09:00', '12:00', 4, 1);
  const past = insertShift(db, event, 'Past Setup', '2026-10-14', '09:00', '12:00', 2, 0);
  const live = insertShift(db, event, 'Live Greeting', '2026-10-14', '12:00', '15:00', 2, 0);
  const hiddenShift = insertShift(db, hidden, 'Hidden Shift', '2026-10-18', '09:00', '12:00', 2, 0);
  return { open, full, cancelled, past, live, hidden: hiddenShift };
}

function insertEvent(
  db: import('better-sqlite3').Database,
  values: { slug: string; title: string; description: string; published: number },
): number {
  const result = db
    .prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, ?, 'Sioux Center, Iowa', 'America/Chicago', ?, '2026-10-01T15:00:00.000Z')`,
    )
    .run(values.slug, values.title, values.description, values.published);
  return Number(result.lastInsertRowid);
}

function insertShift(
  db: import('better-sqlite3').Database,
  eventId: number,
  role: string,
  date: string,
  start: string,
  end: string,
  capacity: number,
  cancelled: number,
): number {
  const times = localShiftToUtc(date, start, end, 'America/Chicago');
  const result = db
    .prepare(
      `INSERT INTO shifts (
         event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled
       ) VALUES (?, ?, ?, ?, ?, 'SECRET-SHIFT-NOTE', ?)`,
    )
    .run(eventId, role, times.startsAtUtc, times.endsAtUtc, capacity, cancelled);
  return Number(result.lastInsertRowid);
}

function versionedAsset(html: string, file: string): string {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`${escaped}\\?v=([A-Za-z0-9_-]+)`));
  if (!match?.[1]) throw new Error(`Missing versioned asset ${file}`);
  return `${file}?v=${match[1]}`;
}

function insertSignup(db: import('better-sqlite3').Database, shiftId: number): void {
  db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, is_minor, group_size, notes, status, reminders_off, created_at, updated_at
     ) VALUES (?, 'Secret Person', 'secret.person@example.invalid', 'secret.person@example.invalid', 0, 1, 'SECRET-PERSON-NOTE', 'confirmed', 0, '2026-10-01T15:00:00.000Z', '2026-10-01T15:00:00.000Z')`,
  ).run(shiftId);
}

describe('security headers', () => {
  it('sends HSTS only for an https origin', async () => {
    for (const https of [true, false]) {
      const app = new Hono();
      app.use('*', securityHeaders({ https }));
      app.get('/', (c) => c.text('ok'));
      const response = await app.request('/');
      expect(response.headers.get('strict-transport-security')).toBe(https ? STRICT_TRANSPORT_SECURITY : null);
      expect(response.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    }
  });
});
