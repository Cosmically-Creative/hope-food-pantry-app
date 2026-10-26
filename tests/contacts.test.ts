import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { loadConfig } from '../src/config.js';
import {
  CONTACT_CSV_BINARY,
  CONTACT_CSV_COLUMNS,
  CONTACT_CSV_EMPTY,
  CONTACT_CSV_LARGE,
  CONTACT_CSV_LIMIT,
  CONTACT_CSV_READ,
  CONTACT_LIST_PAGE,
  contactImportSentence,
  contactListLimit,
  exportContacts,
  importContactCsv,
  rememberSignupContact,
} from '../src/contacts.js';
import { openAppDatabase } from '../src/db.js';
import { devEnv } from './env.js';

const NOW = '2026-10-14T18:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:3000';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

const PEOPLE = [
  'First Name,Last Name,Email,Phone,Address',
  'kristi ,ANDERSON,Kristi@Example.invalid,712441076,123 Main',
  'Kara,Acevedo,kara@example.invalid,,',
  'Kara,Acevedo,kara.other@example.invalid,7125550100,456 Oak',
  'Not An,Email,not-an-email,,',
].join('\r\n');

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('contact spreadsheet', () => {
  it('keeps two emails for one name, ignores address, and skips a bad email or blank phone', async () => {
    const db = await openDb();
    const imported = importContactCsv(db, null, PEOPLE, NOW);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.result.added).toBe(2);
    expect(imported.result.skipped).toBe(2);
    expect(imported.result.skips).toEqual([
      { line: 3, code: 'm' },
      { line: 5, code: 'e' },
    ]);
    expect(contactImportSentence(imported.result)).toBe('Saved 2 new contacts. Skipped 2 rows.');
    const rows = db
      .prepare('SELECT first_name, last_name, email, phone FROM contacts ORDER BY id')
      .all() as { first_name: string; last_name: string; email: string; phone: string | null }[];
    expect(rows).toEqual([
      { first_name: 'Kristi', last_name: 'Anderson', email: 'kristi@example.invalid', phone: '712441076' },
      { first_name: 'Kara', last_name: 'Acevedo', email: 'kara.other@example.invalid', phone: '712-555-0100' },
    ]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM outbox')).toBe(0);
    const audit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'contacts.import'`).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toEqual({ added: 2, changed: 0, unchanged: 0, skipped: 2 });
    expect(audit.detail_json).not.toContain('@');
  });

  it('keeps two names that share an email and updates only the matching name', async () => {
    const db = await openDb();
    importContactCsv(db, null, 'First Name,Last Name,Email,Phone\nAda,One,ada@example.invalid,111\n', NOW);
    const renamed = importContactCsv(db, null, 'First Name,Last Name,Email,Phone\nAda,Two,ADA@example.invalid,222\n', NOW);
    expect(renamed.ok && renamed.result.added).toBe(1);
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts ORDER BY id').all()).toEqual([
      { first_name: 'Ada', last_name: 'One', phone: '111' },
      { first_name: 'Ada', last_name: 'Two', phone: '222' },
    ]);
    const replaced = importContactCsv(db, null, 'First Name,Last Name,Email,Phone\nada,two,ada@example.invalid,(712) 555-0100\n', NOW);
    expect(replaced.ok && replaced.result.changed).toBe(1);
    expect(db.prepare('SELECT phone FROM contacts ORDER BY id').all()).toEqual([{ phone: '111' }, { phone: '712-555-0100' }]);
    const blankPhone = importContactCsv(db, null, 'First Name,Last Name,Email,Phone\nAda,Two,ada@example.invalid,\n', NOW);
    expect(blankPhone.ok && blankPhone.result.skipped).toBe(1);
    expect(blankPhone.ok && blankPhone.result.skips).toEqual([{ line: 2, code: 'm' }]);
    expect(db.prepare("SELECT phone FROM contacts WHERE last_name = 'Two'").get()).toEqual({ phone: '712-555-0100' });
    const same = importContactCsv(db, null, 'First Name,Last Name,Email,Phone\nAda,Two,ada@example.invalid,712-555-0100\n', NOW);
    expect(same.ok && same.result.unchanged).toBe(1);
    expect(db.prepare("SELECT phone FROM contacts WHERE last_name = 'Two'").get()).toEqual({ phone: '712-555-0100' });
    const shaped = importContactCsv(
      db,
      null,
      'First Name,Last Name,Email,Phone\nMcDonald,O\'BRIEN,mac@example.invalid,17125550199\njohn,SMITH,john@example.invalid,712 555 0199\n',
      NOW,
    );
    expect(shaped.ok && shaped.result.added).toBe(2);
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts WHERE email = ?').all('mac@example.invalid')).toEqual([
      { first_name: 'McDonald', last_name: "O'Brien", phone: '712-555-0199' },
    ]);
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts WHERE email = ?').get('john@example.invalid')).toEqual({
      first_name: 'John',
      last_name: 'Smith',
      phone: '712-555-0199',
    });
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(4);
  });

  it('round-trips a formula-looking name and a comma in the last name', async () => {
    const db = await openDb();
    const first = importContactCsv(
      db,
      null,
      'First Name,Last Name,Email,Phone,Address\n=Ada,"De Jong, Jr",ada@example.invalid,+1 712,\n',
      NOW,
    );
    expect(first.ok && first.result.added).toBe(1);
    const exported = exportContacts(db);
    expect(exported.csv.startsWith('\uFEFFFirst Name,Last Name,Email,Phone,Address\r\n')).toBe(true);
    expect(exported.csv).toContain("'=Ada");
    expect(exported.csv).toContain("'+1 712");
    expect(exported.csv).toContain('"De Jong, Jr"');
    const again = importContactCsv(db, null, exported.csv, NOW);
    expect(again.ok && again.result.unchanged).toBe(1);
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts').get()).toEqual({
      first_name: '=Ada',
      last_name: 'De Jong, Jr',
      phone: '+1 712',
    });
  });

  it('refuses a roster file, an empty file, a broken quote, and too many rows', async () => {
    const db = await openDb();
    expect(importContactCsv(db, null, 'Date,Start,Name,Email\n2026-10-15,9:00,Ada,ada@example.invalid\n', NOW)).toEqual({
      ok: false,
      error: CONTACT_CSV_COLUMNS,
    });
    expect(importContactCsv(db, null, '   ', NOW)).toEqual({ ok: false, error: CONTACT_CSV_EMPTY });
    expect(importContactCsv(db, null, 'First Name,Last Name,Email\nAda,One,ada@example.invalid\n', NOW)).toEqual({
      ok: false,
      error: CONTACT_CSV_COLUMNS,
    });
    expect(importContactCsv(db, null, 'First Name,Last Name,Email,Phone\n"Ada,One,ada@example.invalid,555\n', NOW)).toEqual({
      ok: false,
      error: CONTACT_CSV_READ,
    });
    expect(importContactCsv(db, null, 'First Name,Last Name,Email,Phone\0\n', NOW)).toEqual({ ok: false, error: CONTACT_CSV_BINARY });
    expect(importContactCsv(db, null, `First Name,Last Name,Email,Phone\n${'x'.repeat(64 * 1024)}`, NOW)).toEqual({
      ok: false,
      error: CONTACT_CSV_LIMIT,
    });
    const lines = ['First Name,Last Name,Email,Phone'];
    for (let i = 0; i < 2001; i += 1) lines.push(`A,B,a${i}@b.c,555`);
    expect(importContactCsv(db, null, lines.join('\n'), NOW)).toEqual({ ok: false, error: CONTACT_CSV_LARGE });
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(0);
  });

  it('saves each signup name as its own contact and keeps a short phone as written', async () => {
    const db = await openDb();
    rememberSignupContact(db, { name: 'pat review', email: ' Pat@Example.invalid ', phone: '7125550199' }, NOW);
    expect(db.prepare('SELECT first_name, last_name, email, phone FROM contacts').get()).toEqual({
      first_name: 'Pat',
      last_name: 'Review',
      email: 'pat@example.invalid',
      phone: '712-555-0199',
    });
    rememberSignupContact(db, { name: 'Pat', email: 'pat@example.invalid', phone: null }, NOW);
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts ORDER BY id').all()).toEqual([
      { first_name: 'Pat', last_name: 'Review', phone: '712-555-0199' },
      { first_name: 'Pat', last_name: '-', phone: null },
    ]);
    rememberSignupContact(db, { name: 'Sam', email: 'sam@example.invalid', phone: '' }, NOW);
    rememberSignupContact(db, { name: 'sam other', email: 'sam@example.invalid', phone: null }, NOW);
    expect(db.prepare("SELECT first_name, last_name, phone FROM contacts WHERE email = 'sam@example.invalid' ORDER BY id").all()).toEqual([
      { first_name: 'Sam', last_name: '-', phone: null },
      { first_name: 'Sam', last_name: 'Other', phone: null },
    ]);
    rememberSignupContact(db, { name: 'PAT REVIEW', email: 'pat@example.invalid', phone: '555' }, NOW);
    expect(db.prepare("SELECT phone FROM contacts WHERE last_name = 'Review'").get()).toEqual({ phone: '555' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(4);
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'contacts.manual'")).toBe(0);
  });

  it('starts the list at one page and ignores a smaller shown count', () => {
    expect(contactListLimit(undefined)).toBe(CONTACT_LIST_PAGE);
    expect(contactListLimit('5')).toBe(CONTACT_LIST_PAGE);
    expect(contactListLimit('shown')).toBe(CONTACT_LIST_PAGE);
    expect(contactListLimit('40')).toBe(40);
  });
});

describe('contact pages', () => {
  it('shows the next page of contacts and keeps the search', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const lines = ['First Name,Last Name,Email,Phone'];
    for (let i = 0; i <= CONTACT_LIST_PAGE; i += 1) {
      const name = String(i).padStart(2, '0');
      lines.push(`Ada,N${name},n${name}@example.invalid,712-555-${name}00`);
    }
    const imported = await postFile(app, cookie, lines.join('\n'));
    expect(imported.status).toBe(303);
    const first = await app.request('/admin/contacts', { headers: { cookie } });
    const firstHtml = await first.text();
    expect(firstHtml).toContain('Ada N00');
    expect(firstHtml).toContain(`Ada N${String(CONTACT_LIST_PAGE - 1).padStart(2, '0')}`);
    expect(rowMarkup(firstHtml, 'Ada N00')).not.toContain('hidden');
    expect(rowMarkup(firstHtml, `Ada N${String(CONTACT_LIST_PAGE).padStart(2, '0')}`)).toContain('hidden');
    expect(firstHtml).toContain('See more');
    expect(firstHtml).toContain(`data-see-more="${CONTACT_LIST_PAGE}"`);
    expect(firstHtml).toContain(`shown=${CONTACT_LIST_PAGE * 2}#contact-more`);
    expect(firstHtml).not.toContain('#contacts-list');
    expect(firstHtml).toMatch(/href="\/admin\/contacts\/\d+"/);

    const searched = await app.request('/admin/contacts?q=ada', { headers: { cookie } });
    const searchedHtml = await searched.text();
    expect(searchedHtml).toContain('See more');
    expect(searchedHtml).toContain('q=ada');
    expect(searchedHtml).toContain(`shown=${CONTACT_LIST_PAGE * 2}`);

    const rest = await app.request(`/admin/contacts?shown=${CONTACT_LIST_PAGE * 2}`, { headers: { cookie } });
    const restHtml = await rest.text();
    expect(rowMarkup(restHtml, `Ada N${String(CONTACT_LIST_PAGE).padStart(2, '0')}`)).not.toContain('hidden');
    expect(restHtml).not.toContain('See more');
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(CONTACT_LIST_PAGE + 1);
  });

  it('imports a file for a coordinator and keeps it off the public site', async () => {
    const { app, db } = await buildApp();
    const loggedOut = await app.request('/admin/contacts');
    expect(loggedOut.status).toBe(303);
    expect(await loggedOut.text()).not.toContain('example.invalid');

    const cookie = await signIn(app, db);
    const home = await app.request('/admin', { headers: { cookie } });
    expect(await home.text()).toContain('href="/admin/contacts"');

    const stale = await postFile(app, cookie, PEOPLE, 'nope');
    expect(stale.status).toBe(403);
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(0);

    const imported = await postFile(app, cookie, PEOPLE);
    expect(imported.status).toBe(303);
    const page = await app.request(imported.headers.get('location') ?? '', { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Saved 2 new contacts. Skipped 2 rows.');
    expect(html).toContain('Row 3 was skipped because the phone is missing.');
    expect(html).toContain('Row 5 was skipped because the email is not an address.');
    expect(html).toContain('Kristi Anderson');
    expect(html).toContain('kara.other@example.invalid');
    expect(html).not.toContain('not-an-email');
    expect(html).not.toContain('123 Main');
    expect(await (await app.request('/')).text()).not.toContain('kristi@example.invalid');
    expect(await (await app.request('/')).text()).not.toContain('Kristi Anderson');

    const searched = await app.request('/admin/contacts?q=%3Cscript%3E', { headers: { cookie } });
    const searchHtml = await searched.text();
    expect(searchHtml).toContain('value="&lt;script&gt;"');
    expect(searchHtml).not.toContain('value="<script>"');
    expect(searchHtml).toContain('No contacts match.');

    const found = await app.request('/admin/contacts?q=kristi', { headers: { cookie } });
    const foundHtml = await found.text();
    expect(foundHtml).toContain('Kristi Anderson');
    expect(foundHtml).not.toContain('kara@example.invalid');
    expect(foundHtml).not.toContain('See more');

    const file = await postExport(app, cookie);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/csv');
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="hope-contacts.csv"');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain('kristi@example.invalid');
    expect(csv).not.toContain('123 Main');
    const exportAudit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'contacts.export'`).get() as {
      detail_json: string;
    };
    expect(exportAudit.detail_json).toBe('{"rows":2}');

    const hidden = await app.request('/admin/contacts/export', { method: 'POST' });
    expect(hidden.status).toBe(303);
    expect(await hidden.text()).not.toContain('kristi@example.invalid');
  });

  it('fills a walk-in from a saved contact and can remove the contact afterward', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    await postFile(app, cookie, 'First Name,Last Name,Email,Phone\nAda,Example,ada@example.invalid,7125550101\n');
    const shiftId = insertShift(db);
    const shift = await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } });
    const shiftHtml = await shift.text();
    expect(shiftHtml).toContain('Saved contact');
    expect(shiftHtml).toContain('data-contact');
    const contactId = /value="(\d+)" data-name="Ada Example"/.exec(shiftHtml)?.[1] ?? '';
    expect(contactId).not.toBe('');

    const added = await postWalkIn(app, cookie, shiftId, shiftHtml, { contact: contactId, name: '', email: '', phone: '' });
    expect(added.status).toBe(303);
    expect(added.headers.get('location')).toContain('notice=walk-in');
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid' AND name = 'Ada Example'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation' AND to_email = 'ada@example.invalid'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(1);

    const typedPage = await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } });
    const typed = await postWalkIn(app, cookie, shiftId, await typedPage.text(), {
      name: 'Pat Example',
      email: 'pat@example.invalid',
      phone: '7125550199',
    });
    expect(typed.status).toBe(303);
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);
    expect(db.prepare("SELECT first_name, last_name, phone FROM contacts WHERE email = 'pat@example.invalid'").get()).toEqual({
      first_name: 'Pat',
      last_name: 'Example',
      phone: '712-555-0199',
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'pat@example.invalid'")).toBe(1);

    const missing = await postWalkIn(app, cookie, shiftId, await (await app.request(`/admin/shifts/${shiftId}`, { headers: { cookie } })).text(), {
      contact: '999',
      name: '',
      email: '',
    });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('That saved contact is not available.');

    const asking = await app.request(`/admin/contacts/${contactId}/remove`, { headers: { cookie } });
    const askingHtml = await asking.text();
    expect(askingHtml).toContain('Remove Ada Example');
    expect(askingHtml).toContain('does not cancel a signup');
    const removed = await postRemove(app, cookie, `/admin/contacts/${contactId}/remove`);
    expect(removed.status).toBe(303);
    const after = await app.request(removed.headers.get('location') ?? '', { headers: { cookie } });
    expect(await after.text()).toContain('That person is removed from the contact list.');
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid' AND status = 'confirmed'")).toBe(1);
    const removeAudit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'contacts.remove'`).get() as {
      detail_json: string;
    };
    expect(removeAudit.detail_json).toBe(`{"id":${contactId}}`);
    expect(removeAudit.detail_json).not.toContain('@');
  });

  it('adds a contact to an open shift and leaves full, ended, and cancelled shifts off the list', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const openId = insertShift(db);
    const unpublishedId = insertShift(db, {
      slug: 'soup',
      title: 'Soup kitchen',
      role: 'Serving',
      published: 0,
      start: '2026-10-22T14:00:00.000Z',
      end: '2026-10-22T17:00:00.000Z',
    });
    insertShift(db, {
      slug: 'closed',
      title: 'Closed pantry',
      role: 'Closing',
      cancelled: 1,
    });
    insertShift(db, {
      slug: 'finished',
      title: 'Finished pantry',
      role: 'Finished',
      start: '2026-10-14T14:00:00.000Z',
      end: '2026-10-14T17:00:00.000Z',
    });
    const fullId = insertShift(db, {
      slug: 'packed',
      title: 'Packed pantry',
      role: 'Packing',
      capacity: 1,
      start: '2026-10-23T14:00:00.000Z',
      end: '2026-10-23T17:00:00.000Z',
    });
    db.prepare(
      `INSERT INTO signups (shift_id, name, email, email_norm, group_size, status, created_at, updated_at)
       VALUES (?, 'Other Person', 'other@example.invalid', 'other@example.invalid', 1, 'confirmed', ?, ?)`,
    ).run(fullId, NOW, NOW);

    const imported = await postFile(app, cookie, 'First Name,Last Name,Email,Phone\nAda,Example,ada@example.invalid,555-0100\n');
    expect(imported.status).toBe(303);
    const contactId = (db.prepare(`SELECT id AS id FROM contacts WHERE email = 'ada@example.invalid'`).get() as { id: number }).id;
    const loggedOut = await app.request(`/admin/contacts/${contactId}`);
    expect(loggedOut.status).toBe(303);

    const list = await app.request('/admin/contacts', { headers: { cookie } });
    expect(await list.text()).toContain(`href="/admin/contacts/${contactId}"`);

    const person = await app.request(`/admin/contacts/${contactId}`, { headers: { cookie } });
    const personHtml = await person.text();
    expect(person.status).toBe(200);
    expect(personHtml).toContain('555-0100');
    expect(personHtml).toContain('id="add-shift"');
    expect(personHtml).toContain('Choose a shift');
    const addMenu = /<select\b[^>]*\bid="add-shift"[^>]*>([\s\S]*?)<\/select>/.exec(personHtml)?.[1] ?? '';
    const wednesday = addMenu.indexOf('<optgroup label="Wednesday, October 21, 2026">');
    const thursday = addMenu.indexOf('<optgroup label="Thursday, October 22, 2026">');
    expect(wednesday).toBeGreaterThanOrEqual(0);
    expect(addMenu.indexOf(`<option value="${openId}">`)).toBeGreaterThan(wednesday);
    expect(thursday).toBeGreaterThan(wednesday);
    expect(addMenu.indexOf(`<option value="${unpublishedId}">`)).toBeGreaterThan(thursday);
    expect(addMenu).toContain('>Weekly pantry: Sorting, October 21, 2026, 9:00 AM to 12:00 PM CDT<');
    expect(addMenu).toContain('>Soup kitchen: Serving, October 22, 2026, 9:00 AM to 12:00 PM CDT (not on the public list)<');
    expect(personHtml).toContain('Serving');
    expect(personHtml).toContain('(not on the public list)');
    expect(personHtml).not.toContain('Closing');
    expect(personHtml).not.toContain('Finished');
    expect(personHtml).not.toContain('Packing');
    expect(personHtml).toContain('Add to this shift');
    expect(personHtml).not.toContain('They are under 18');

    const beforeMail = count(db, `SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation'`);
    expect(beforeMail).toBe(0);

    const stale = await postContactShift(app, cookie, contactId, openId, personHtml.replace(/name="form_token" value="[^"]*"/, 'name="form_token" value="nope"'), {});
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('This form is out of date. Submit it again.');

    const full = await postContactShift(app, cookie, contactId, fullId, personHtml, {});
    expect(full.status).toBe(400);
    expect(await full.text()).toContain('That shift is not open.');
    expect(count(db, `SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid'`)).toBe(0);

    const added = await postContactShift(app, cookie, contactId, openId, personHtml, { notes: 'Came to the door' });
    expect(added.status).toBe(303);
    expect(added.headers.get('location')).toBe(`/admin/shifts/${openId}?notice=walk-in`);
    const roster = await app.request(added.headers.get('location') ?? '', { headers: { cookie } });
    const rosterHtml = await roster.text();
    expect(rosterHtml).toContain('They are on this shift. A confirmation email is queued.');
    expect(rosterHtml).toContain('Ada Example');
    expect(count(db, `SELECT COUNT(*) AS n FROM contacts`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid' AND status = 'confirmed'`)).toBe(1);
    expect((db.prepare(`SELECT phone AS phone, notes AS notes FROM signups WHERE email_norm = 'ada@example.invalid'`).get() as { phone: string; notes: string }).phone).toBe('555-0100');
    expect((db.prepare(`SELECT notes AS notes FROM signups WHERE email_norm = 'ada@example.invalid'`).get() as { notes: string }).notes).toBe('Came to the door');
    expect(count(db, `SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation'`)).toBe(1);
    const walkInAudit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'signup.walkin'`).get() as { detail_json: string };
    expect(walkInAudit.detail_json).not.toContain('@');

    const beaFile = await postFile(app, cookie, 'First Name,Last Name,Email,Phone\nBea,Example,bea@example.invalid,712-555-0102\n');
    expect(beaFile.status).toBe(303);
    const beaId = (db.prepare(`SELECT id AS id FROM contacts WHERE email = 'bea@example.invalid'`).get() as { id: number }).id;
    const beaPage = await app.request(`/admin/contacts/${beaId}`, { headers: { cookie } });
    const beaHtml = await beaPage.text();
    expect(beaPage.status).toBe(200);
    expect(beaHtml).toContain(`<option value="${unpublishedId}">`);
    const beaAdded = await postContactShift(app, cookie, beaId, unpublishedId, beaHtml, {});
    expect(beaAdded.status).toBe(303);
    const beaSignup = db.prepare(
      `SELECT is_minor AS is_minor, guardian_name AS guardian_name, guardian_email AS guardian_email
       FROM signups WHERE email_norm = 'bea@example.invalid'`,
    ).get() as { is_minor: number; guardian_name: string | null; guardian_email: string | null };
    expect(beaSignup).toEqual({ is_minor: 0, guardian_name: null, guardian_email: null });
    expect(count(db, `SELECT COUNT(*) AS n FROM contacts`)).toBe(2);
    const mailed = db
      .prepare(`SELECT to_email AS to_email FROM outbox WHERE kind = 'confirmation' ORDER BY to_email`)
      .all() as Array<{ to_email: string }>;
    expect(mailed.map((row) => row.to_email)).toEqual(['ada@example.invalid', 'bea@example.invalid']);

    const againPage = await app.request(`/admin/contacts/${contactId}`, { headers: { cookie } });
    const againPageHtml = await againPage.text();
    expect(againPageHtml).not.toContain(`<option value="${openId}">`);
    const again = await postContactShift(app, cookie, contactId, openId, againPageHtml, {});
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('That person is already signed up for this shift.');
    expect(count(db, `SELECT COUNT(*) AS n FROM signups WHERE email_norm = 'ada@example.invalid'`)).toBe(1);
  });

  it('saves one contact by hand and does not sign them up', async () => {
    const { app, db } = await buildApp();
    const loggedOut = await app.request('/admin/contacts/new', { method: 'POST' });
    expect(loggedOut.status).toBe(303);
    const cookie = await signIn(app, db);
    const page = await app.request('/admin/contacts', { headers: { cookie } });
    expect(await page.text()).toContain('Save this contact');

    const saved = await postManual(app, cookie, { firstName: 'ada', lastName: 'example', email: 'Ada@Example.invalid', phone: '7125550100' });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/contacts?notice=contact-saved');
    const after = await app.request(saved.headers.get('location') ?? '', { headers: { cookie } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain('That contact is saved.');
    expect(afterHtml).toContain('Ada Example');
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts').get()).toEqual({
      first_name: 'Ada',
      last_name: 'Example',
      phone: '712-555-0100',
    });
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation'")).toBe(0);
    const manualAudit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'contacts.manual'`).get() as { detail_json: string };
    expect(manualAudit.detail_json).not.toContain('@');

    const same = await postManual(app, cookie, { firstName: 'Ada', lastName: 'Example', email: 'ada@example.invalid', phone: '712-555-0100' });
    expect(same.headers.get('location')).toBe('/admin/contacts?notice=contact-matched');
    expect(db.prepare('SELECT phone FROM contacts').get()).toEqual({ phone: '712-555-0100' });

    const changed = await postManual(app, cookie, { firstName: 'ADA', lastName: 'EXAMPLE', email: 'ada@example.invalid', phone: '712-555-0199' });
    expect(changed.status).toBe(303);
    expect(changed.headers.get('location')).toBe('/admin/contacts?notice=contact-updated');
    expect(db.prepare('SELECT phone FROM contacts').get()).toEqual({ phone: '712-555-0199' });

    const other = await postManual(app, cookie, { firstName: 'Ada', lastName: 'Other', email: 'ada@example.invalid', phone: '712-555-0111' });
    expect(other.headers.get('location')).toBe('/admin/contacts?notice=contact-saved');
    expect(db.prepare('SELECT first_name, last_name, phone FROM contacts ORDER BY id').all()).toEqual([
      { first_name: 'Ada', last_name: 'Example', phone: '712-555-0199' },
      { first_name: 'Ada', last_name: 'Other', phone: '712-555-0111' },
    ]);

    const blankPhone = await postManual(app, cookie, { firstName: 'Sam', lastName: 'Example', email: 'sam@example.invalid', phone: '' });
    expect(blankPhone.status).toBe(400);
    expect(await blankPhone.text()).toContain('Enter a phone number.');
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);

    const invalid = await postManual(app, cookie, { firstName: '', lastName: 'Example', email: 'not-an-email', phone: '' });
    expect(invalid.status).toBe(400);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain('Enter a first name.');
    expect(invalidHtml).toContain('Enter an email address.');
    expect(invalidHtml).toContain('Enter a phone number.');
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);
    expect(await (await app.request('/')).text()).not.toContain('ada@example.invalid');
  });

  it('corrects a saved name, email, or phone without creating another person', async () => {
    const { app, db } = await buildApp();
    const cookie = await signIn(app, db);
    const openId = insertShift(db);
    await postFile(
      app,
      cookie,
      'First Name,Last Name,Email,Phone\nPat,-,pat@example.invalid,7125550101\nPat,Other,pat@example.invalid,222\n',
    );
    const contactId = (db.prepare(`SELECT id AS id FROM contacts WHERE last_name = '-'`).get() as { id: number }).id;
    const otherId = (db.prepare(`SELECT id AS id FROM contacts WHERE last_name = 'Other'`).get() as { id: number }).id;

    const person = await app.request(`/admin/contacts/${contactId}`, { headers: { cookie } });
    const personHtml = await person.text();
    expect(person.status).toBe(200);
    expect(personHtml).toContain('Correct this contact');
    expect(personHtml).toContain('Save this correction');
    expect(personHtml).toContain('value="Pat"');
    expect(personHtml).toContain('value="-"');
    expect(personHtml).toContain('value="pat@example.invalid"');
    expect(personHtml).toContain('value="712-555-0101"');
    expect(personHtml).toContain('Add to this shift');

    const loggedOut = await app.request(`/admin/contacts/${contactId}`, { method: 'POST' });
    expect(loggedOut.status).toBe(303);
    expect(db.prepare('SELECT last_name, phone FROM contacts WHERE id = ?').get(contactId)).toEqual({
      last_name: '-',
      phone: '712-555-0101',
    });

    const stale = await postCorrect(app, cookie, contactId, {
      firstName: 'Pat',
      lastName: 'Review',
      email: 'pat@example.invalid',
      phone: '7125550199',
      csrf: 'nope',
    });
    expect(stale.status).toBe(403);
    expect(db.prepare('SELECT last_name FROM contacts WHERE id = ?').get(contactId)).toEqual({ last_name: '-' });

    const corrected = await postCorrect(app, cookie, contactId, {
      firstName: 'pat',
      lastName: 'review',
      email: 'Pat@Example.invalid',
      phone: '7125550199',
    });
    expect(corrected.status).toBe(303);
    expect(corrected.headers.get('location')).toBe(`/admin/contacts/${contactId}?notice=contact-corrected`);
    const after = await app.request(corrected.headers.get('location') ?? '', { headers: { cookie } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain('That contact is corrected.');
    expect(afterHtml).toContain('Pat Review');
    expect(afterHtml).toContain('value="Review"');
    expect(afterHtml).toContain('value="712-555-0199"');
    expect(db.prepare('SELECT id, first_name, last_name, email, phone FROM contacts ORDER BY id').all()).toEqual([
      { id: contactId, first_name: 'Pat', last_name: 'Review', email: 'pat@example.invalid', phone: '712-555-0199' },
      { id: otherId, first_name: 'Pat', last_name: 'Other', email: 'pat@example.invalid', phone: '222' },
    ]);
    const correctAudit = db.prepare(`SELECT detail_json AS detail_json FROM audit WHERE action = 'contacts.correct'`).get() as {
      detail_json: string;
    };
    expect(correctAudit.detail_json).toBe(`{"id":${contactId}}`);
    expect(correctAudit.detail_json).not.toContain('@');
    expect(count(db, 'SELECT COUNT(*) AS n FROM signups')).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM outbox WHERE kind = 'confirmation'`)).toBe(0);

    const added = await postContactShift(app, cookie, contactId, openId, afterHtml, {});
    expect(added.status).toBe(303);
    expect(db.prepare(`SELECT name AS name, phone AS phone FROM signups WHERE email_norm = 'pat@example.invalid'`).get()).toEqual({
      name: 'Pat Review',
      phone: '712-555-0199',
    });
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);

    const same = await postCorrect(app, cookie, contactId, {
      firstName: 'Pat',
      lastName: 'Review',
      email: 'pat@example.invalid',
      phone: '712-555-0199',
    });
    expect(same.headers.get('location')).toBe(`/admin/contacts/${contactId}?notice=contact-same`);
    expect(count(db, `SELECT COUNT(*) AS n FROM audit WHERE action = 'contacts.correct'`)).toBe(1);

    const renamedEmail = await postCorrect(app, cookie, contactId, {
      firstName: 'Pat',
      lastName: 'Review',
      email: 'Patrick@Example.invalid',
      phone: '712-555-0199',
    });
    expect(renamedEmail.headers.get('location')).toBe(`/admin/contacts/${contactId}?notice=contact-corrected`);
    expect(db.prepare('SELECT email, phone FROM contacts WHERE id = ?').get(contactId)).toEqual({
      email: 'patrick@example.invalid',
      phone: '712-555-0199',
    });
    expect(db.prepare('SELECT email FROM contacts WHERE id = ?').get(otherId)).toEqual({ email: 'pat@example.invalid' });

    const taken = await postCorrect(app, cookie, contactId, {
      firstName: 'Pat',
      lastName: 'Other',
      email: 'pat@example.invalid',
      phone: '712-555-0199',
    });
    expect(taken.status).toBe(400);
    const takenHtml = await taken.text();
    expect(takenHtml).toContain('That name and email are already saved as another contact.');
    expect(takenHtml).toContain('value="Other"');
    expect(db.prepare('SELECT first_name, last_name, email FROM contacts WHERE id = ?').get(contactId)).toEqual({
      first_name: 'Pat',
      last_name: 'Review',
      email: 'patrick@example.invalid',
    });
    expect(count(db, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);

    const cleared = await postCorrect(app, cookie, contactId, {
      firstName: 'Pat',
      lastName: 'Review',
      email: 'patrick@example.invalid',
      phone: '',
    });
    expect(cleared.status).toBe(400);
    expect(await cleared.text()).toContain('Enter a phone number.');
    expect(db.prepare('SELECT phone FROM contacts WHERE id = ?').get(contactId)).toEqual({ phone: '712-555-0199' });
    expect(db.prepare(`SELECT phone AS phone FROM signups WHERE email_norm = 'pat@example.invalid'`).get()).toEqual({
      phone: '712-555-0199',
    });

    const invalid = await postCorrect(app, cookie, contactId, {
      firstName: '',
      lastName: 'Review',
      email: 'not-an-email',
      phone: '7125550199',
    });
    expect(invalid.status).toBe(400);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain('Enter a first name.');
    expect(invalidHtml).toContain('Enter an email address.');
    expect(db.prepare('SELECT first_name, email, phone FROM contacts WHERE id = ?').get(contactId)).toEqual({
      first_name: 'Pat',
      email: 'patrick@example.invalid',
      phone: '712-555-0199',
    });

    const missing = await postCorrect(app, cookie, 999, {
      firstName: 'Pat',
      lastName: 'Review',
      email: 'patrick@example.invalid',
      phone: '712-555-0199',
    });
    expect(missing.status).toBe(404);
    expect(count(db, `SELECT COUNT(*) AS n FROM audit WHERE action = 'contacts.correct'`)).toBe(2);
  });
});

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-contacts-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  return db;
}

async function buildApp() {
  const db = await openDb();
  bootstrapAdmin(db, 'coordinator@example.invalid', NOW);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(path.dirname(path.dirname(db.name)), 'data') }));
  const app = createApp(config, db, {
    now: NOW,
    clientIp: () => '203.0.113.50',
    verifyTurnstile: async () => ({ ok: true }),
  });
  return { app, db };
}

function insertShift(
  db: Awaited<ReturnType<typeof openDb>>,
  options?: {
    role?: string;
    start?: string;
    end?: string;
    capacity?: number;
    cancelled?: number;
    published?: number;
    title?: string;
    slug?: string;
  },
): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', 'America/Chicago', ?, ?)`,
    ).run(options?.slug ?? 'weekly', options?.title ?? 'Weekly pantry', options?.published ?? 1, NOW).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, ?, ?, ?, ?, '', ?)`,
    ).run(
      eventId,
      options?.role ?? 'Sorting',
      options?.start ?? '2026-10-21T14:00:00.000Z',
      options?.end ?? '2026-10-21T17:00:00.000Z',
      options?.capacity ?? 4,
      options?.cancelled ?? 0,
    ).lastInsertRowid,
  );
}

function rowMarkup(html: string, name: string): string {
  const at = html.indexOf(`>${name}<`);
  const li = html.lastIndexOf('<li', at);
  return li < 0 || at < 0 ? '' : html.slice(li, at);
}

function count(db: Awaited<ReturnType<typeof openDb>>, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>['app'], db: Awaited<ReturnType<typeof openDb>>) {
  await app.request('/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'coordinator@example.invalid', company_website: '', 'cf-turnstile-response': 'token' }),
  });
  const queued = db.prepare(`SELECT body_text AS body_text FROM outbox WHERE kind = 'magic_link'`).get() as { body_text: string };
  const token = /\/login\/link\/([A-Za-z0-9_-]+)/.exec(queued.body_text)?.[1] ?? '';
  const page = await app.request(`/login/link/${token}`);
  const proof = /name="proof"[^>]*value="([^"]*)"/.exec(await page.text())?.[1] ?? '';
  const signedIn = await app.request(`/login/link/${token}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ proof }),
  });
  const cookie = /hope_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return `hope_session=${cookie}`;
}

async function postFile(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string, csv: string, csrf?: string) {
  const current = await app.request('/admin/contacts', { headers: { cookie } });
  const token = csrf ?? (/name="csrf" value="([^"]*)"/.exec(await current.text())?.[1] ?? '');
  const body = new FormData();
  body.set('csrf', token);
  body.set('file', new File([csv], 'people.csv', { type: 'text/csv' }));
  return app.request('/admin/contacts/import', {
    method: 'POST',
    headers: { origin: ORIGIN, cookie },
    body,
  });
}

async function postExport(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string) {
  const current = await app.request('/admin/contacts', { headers: { cookie } });
  const token = /name="csrf" value="([^"]*)"/.exec(await current.text())?.[1] ?? '';
  return app.request('/admin/contacts/export', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf: token }),
  });
}

async function postWalkIn(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  shiftId: number,
  html: string,
  fields: { contact?: string; name?: string; email?: string; phone?: string },
) {
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? '';
  const formToken = /name="form_token" value="([^"]*)"/.exec(html)?.[1] ?? '';
  return app.request(`/admin/shifts/${shiftId}/walk-in`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      form_token: formToken,
      contact: fields.contact ?? '',
      name: fields.name ?? '',
      email: fields.email ?? '',
      phone: fields.phone ?? '',
      notes: '',
    }),
  });
}

async function postContactShift(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  contactId: number,
  shiftId: number,
  html: string,
  fields: { notes?: string },
) {
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? '';
  const formToken = /name="form_token" value="([^"]*)"/.exec(html)?.[1] ?? '';
  return app.request(`/admin/contacts/${contactId}/add`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      form_token: formToken,
      shift: String(shiftId),
      notes: fields.notes ?? '',
    }),
  });
}

async function postCorrect(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  contactId: number,
  fields: { firstName: string; lastName: string; email: string; phone?: string; csrf?: string },
) {
  const current = await app.request('/admin/contacts', { headers: { cookie } });
  const token = fields.csrf ?? (/name="csrf" value="([^"]*)"/.exec(await current.text())?.[1] ?? '');
  return app.request(`/admin/contacts/${contactId}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf: token,
      first_name: fields.firstName,
      last_name: fields.lastName,
      email: fields.email,
      phone: fields.phone ?? '',
    }),
  });
}

async function postManual(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  fields: { firstName: string; lastName: string; email: string; phone?: string },
) {
  const current = await app.request('/admin/contacts', { headers: { cookie } });
  const token = /name="csrf" value="([^"]*)"/.exec(await current.text())?.[1] ?? '';
  return app.request('/admin/contacts/new', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf: token,
      first_name: fields.firstName,
      last_name: fields.lastName,
      email: fields.email,
      phone: fields.phone ?? '',
    }),
  });
}

async function postRemove(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string, pathName: string) {
  const current = await app.request(pathName, { headers: { cookie } });
  const token = /name="csrf" value="([^"]*)"/.exec(await current.text())?.[1] ?? '';
  return app.request(pathName, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf: token }),
  });
}
