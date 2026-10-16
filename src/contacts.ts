import type Database from 'better-sqlite3';
import { writeAudit } from './auth/audit.js';
import { EmailAddressError, normalizeEmail } from './email.js';
import { csvCell, csvImportedCell } from './export.js';
import { capitalizeName, formatPhone } from './person-format.js';
import type { SignupValues } from './signup-form.js';
import { isUniqueConstraint } from './sqlite-error.js';

const MAX_ROWS = 2000;
export const CONTACT_LIST_PAGE = 20;
const MAX_TEXT = 64 * 1024;
const MAX_EMAIL = 254;
const MAX_NAME = 80;
const MAX_PHONE = 40;
const MAX_SKIPS = 30;
const CONTROL = /[\u0000-\u001F\u007F]/;

export const CONTACT_CSV_EMPTY = 'Choose a spreadsheet to import.';
export const CONTACT_CSV_COLUMNS = 'This spreadsheet needs First Name, Last Name, and Email columns.';
export const CONTACT_CSV_READ = 'This spreadsheet could not be read.';
export const CONTACT_CSV_LARGE = 'This spreadsheet has more than 2000 people.';
export const CONTACT_CSV_BINARY = 'Save the spreadsheet as CSV.';
export const CONTACT_CSV_LIMIT = 'This spreadsheet has to be under 64 KB.';

export type ContactSkipCode = 'e' | 'n' | 'p' | 'l' | 'c';

export type ContactSkip = { line: number; code: ContactSkipCode };

export type ContactImportSummary = {
  added: number;
  changed: number;
  unchanged: number;
  skipped: number;
  skips: ContactSkip[];
};

export type Contact = {
  id: number;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string | null;
};

type ReadyContact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
};

export type ContactManualValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export type ContactManualErrors = Partial<Record<'firstName' | 'lastName' | 'email' | 'phone', string>>;

type ContactRow = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
};

const SKIP_REASON: Record<ContactSkipCode, string> = {
  e: 'the email is not an address',
  n: 'the name is missing',
  p: 'the phone is too long',
  l: 'the name is too long',
  c: 'a field has a line break',
};

export function contactImportSentence(summary: Pick<ContactImportSummary, 'added' | 'changed' | 'unchanged' | 'skipped'>): string {
  const { added, changed, unchanged, skipped } = summary;
  if (added + changed + unchanged + skipped === 0) return 'That spreadsheet had no contacts.';
  const parts: string[] = [];
  if (added > 0) parts.push(added === 1 ? 'Saved 1 new contact.' : `Saved ${added} new contacts.`);
  if (changed > 0) parts.push(changed === 1 ? 'Updated 1 contact.' : `Updated ${changed} contacts.`);
  if (unchanged > 0) {
    parts.push(
      unchanged === 1
        ? '1 contact already matched and was left as it is.'
        : `${unchanged} contacts already matched and were left as they are.`,
    );
  }
  if (skipped > 0) parts.push(skipped === 1 ? 'Skipped 1 row.' : `Skipped ${skipped} rows.`);
  if (added === 0 && changed === 0 && unchanged === 0) parts.unshift('No contacts were saved.');
  return parts.join(' ');
}

export function contactSkipSentence(skip: ContactSkip): string {
  return `Row ${skip.line} was skipped because ${SKIP_REASON[skip.code]}.`;
}

export function formatContactSkips(skips: ContactSkip[]): string {
  return skips
    .slice(0, MAX_SKIPS)
    .map((skip) => `${skip.line}${skip.code}`)
    .join('.');
}

export function parseContactSkips(value: string | undefined): ContactSkip[] {
  if (!value) return [];
  const skips: ContactSkip[] = [];
  for (const part of value.split('.')) {
    const match = /^(\d+)([enplc])$/.exec(part);
    if (!match) continue;
    const line = Number(match[1]);
    const code = match[2];
    if (!Number.isSafeInteger(line) || line < 1 || !code || !isSkipCode(code)) continue;
    skips.push({ line, code });
    if (skips.length === MAX_SKIPS) break;
  }
  return skips;
}

export function importContactCsv(
  db: Database.Database,
  coordinatorId: number | null,
  text: string,
  now: string,
): { ok: true; result: ContactImportSummary } | { ok: false; error: string } {
  if (text.length > MAX_TEXT) return { ok: false, error: CONTACT_CSV_LIMIT };
  if (text.includes('\u0000')) return { ok: false, error: CONTACT_CSV_BINARY };
  if (text.trim() === '') return { ok: false, error: CONTACT_CSV_EMPTY };
  let table: { line: number; cells: string[] }[];
  try {
    table = parseCsv(text);
  } catch {
    return { ok: false, error: CONTACT_CSV_READ };
  }
  const header = table[0];
  if (!header) return { ok: false, error: CONTACT_CSV_COLUMNS };
  const columns = columnIndex(header.cells);
  if (!columns) return { ok: false, error: CONTACT_CSV_COLUMNS };
  const data = table.slice(1);
  if (data.length > MAX_ROWS) return { ok: false, error: CONTACT_CSV_LARGE };

  const ready: ReadyContact[] = [];
  const skips: ContactSkip[] = [];
  for (const row of data) {
    const parsed = parsePerson(row.cells, columns);
    if ('code' in parsed) skips.push({ line: row.line, code: parsed.code });
    else ready.push(parsed);
  }

  const applied = db.transaction(() => {
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const person of ready) {
      const saved = applyContact(db, person, now);
      if (saved.status === 'added') added += 1;
      else if (saved.status === 'changed') changed += 1;
      else unchanged += 1;
    }
    writeAudit(db, coordinatorId, 'contacts.import', { added, changed, unchanged, skipped: skips.length }, now);
    return { added, changed, unchanged };
  })();

  return { ok: true, result: { ...applied, skipped: skips.length, skips } };
}

export function exportContacts(db: Database.Database): { csv: string; rows: number } {
  const rows = db
    .prepare(
      `SELECT first_name, last_name, email, phone
       FROM contacts
       ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id`,
    )
    .all() as { first_name: string; last_name: string; email: string; phone: string | null }[];
  const lines = [
    ['First Name', 'Last Name', 'Email', 'Phone', 'Address'].map(csvCell).join(','),
    ...rows.map((row) => [row.first_name, row.last_name, row.email, row.phone ?? '', ''].map(csvCell).join(',')),
  ];
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows: rows.length };
}

/** How many contacts to show. A missing or small value starts at the first page. */
export function contactListLimit(value: string | undefined): number {
  if (!value || !/^\d{1,6}$/.test(value)) return CONTACT_LIST_PAGE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < CONTACT_LIST_PAGE) return CONTACT_LIST_PAGE;
  return parsed;
}

export function loadContacts(db: Database.Database, query: string): { total: number; query: string; people: Contact[] } {
  const cleaned = query.normalize('NFC').replace(CONTROL, '').trim().slice(0, MAX_NAME);
  const people = allContacts(db);
  const needle = cleaned.toLocaleLowerCase();
  if (!needle) return { total: people.length, query: cleaned, people };
  return {
    total: people.length,
    query: cleaned,
    people: people.filter(
      (person) =>
        person.name.toLocaleLowerCase().includes(needle) ||
        person.email.includes(needle) ||
        (person.phone ?? '').toLocaleLowerCase().includes(needle),
    ),
  };
}

export function getContact(db: Database.Database, id: number): Contact | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = db.prepare('SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  return row ? present(row) : null;
}

export function removeContact(db: Database.Database, coordinatorId: number, id: number, now: string): boolean {
  return db.transaction(() => {
    const deleted = db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    if (deleted.changes !== 1) return false;
    writeAudit(db, coordinatorId, 'contacts.remove', { id }, now);
    return true;
  })();
}

/**
 * Saves the person from a confirmed signup.
 * The same name and email updates that contact. A different name is a new contact, even with the same email.
 * A blank phone does not erase a phone already saved.
 */
export function rememberSignupContact(
  db: Database.Database,
  input: { name: string; email: string; phone: string | null },
  now: string,
): void {
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    return;
  }
  if (email.length > MAX_EMAIL) return;
  const parts = splitSignupName(input.name);
  if (!parts) return;
  const phone = input.phone?.normalize('NFC').trim() ?? '';
  if (phone.length > MAX_PHONE || CONTROL.test(phone)) return;
  applyContact(
    db,
    { firstName: parts.firstName, lastName: parts.lastName, email, phone: phone.length === 0 ? null : formatPhone(phone) },
    now,
  );
}

export function saveManualContact(
  db: Database.Database,
  coordinatorId: number,
  values: ContactManualValues,
  now: string,
): { ok: true; status: 'added' | 'changed' | 'unchanged' } | { ok: false; errors: ContactManualErrors } {
  const parsed = manualContact(values);
  if (!parsed.ok) return parsed;
  const status = db.transaction(() => {
    const saved = applyContact(db, parsed.person, now);
    if (saved.status !== 'unchanged') writeAudit(db, coordinatorId, 'contacts.manual', { id: saved.id }, now);
    return saved.status;
  })();
  return { ok: true, status };
}

/** Blank name, email, or phone on the form keeps the saved contact's value. */
export function walkInFromContact(contact: Contact, values: SignupValues): SignupValues {
  return {
    ...values,
    name: values.name.trim() ? values.name : contact.name,
    email: values.email.trim() ? values.email : contact.email,
    phone: values.phone.trim() ? values.phone : (contact.phone ?? ''),
  };
}

function allContacts(db: Database.Database): Contact[] {
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, email, phone
       FROM contacts
       ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id`,
    )
    .all() as ContactRow[];
  return rows.map(present);
}

function present(row: ContactRow): Contact {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    email: row.email,
    phone: row.phone,
  };
}

function columnIndex(cells: string[]): { first: number; last: number; email: number; phone: number } | null {
  const names = cells.map((cell) => csvImportedCell(cell).toLowerCase());
  const first = names.indexOf('first name');
  const last = names.indexOf('last name');
  const email = names.indexOf('email');
  const phone = names.indexOf('phone');
  if (first < 0 || last < 0 || email < 0) return null;
  return { first, last, email, phone };
}

function splitSignupName(name: string): { firstName: string; lastName: string } | null {
  if (CONTROL.test(name)) return null;
  const trimmed = capitalizeName(name);
  if (!trimmed) return null;
  const space = trimmed.lastIndexOf(' ');
  if (space > 0) {
    const firstName = trimmed.slice(0, space);
    const lastName = trimmed.slice(space + 1);
    if (`${firstName} ${lastName}`.length > MAX_NAME) return null;
    return { firstName, lastName };
  }
  if (trimmed.length + 2 > MAX_NAME) return null;
  return { firstName: trimmed, lastName: '-' };
}

function manualContact(values: ContactManualValues): { ok: true; person: ReadyContact } | { ok: false; errors: ContactManualErrors } {
  const errors: ContactManualErrors = {};
  const firstRaw = values.firstName.normalize('NFC').trim();
  const lastRaw = values.lastName.normalize('NFC').trim();
  const firstName = capitalizeName(firstRaw);
  const lastName = capitalizeName(lastRaw);
  const phoneRaw = values.phone.normalize('NFC').trim();
  const phone = phoneRaw.length === 0 ? '' : formatPhone(phoneRaw);
  if (!firstRaw || !firstName) errors.firstName = 'Enter a first name.';
  else if (CONTROL.test(firstRaw)) errors.firstName = 'Enter a first name without line breaks.';
  else if (firstRaw.length > MAX_NAME || firstName.length > MAX_NAME) errors.firstName = `Use ${MAX_NAME} characters or fewer.`;
  if (!lastRaw || !lastName) errors.lastName = 'Enter a last name.';
  else if (CONTROL.test(lastRaw)) errors.lastName = 'Enter a last name without line breaks.';
  else if (lastRaw.length > MAX_NAME || lastName.length > MAX_NAME) errors.lastName = `Use ${MAX_NAME} characters or fewer.`;
  if (firstName && lastName && !errors.firstName && !errors.lastName && `${firstName} ${lastName}`.length > MAX_NAME) {
    errors.lastName = `Use ${MAX_NAME} characters or fewer for the full name.`;
  }
  if (CONTROL.test(phoneRaw)) errors.phone = 'Enter a phone number without line breaks.';
  else if (phoneRaw.length > MAX_PHONE || phone.length > MAX_PHONE) errors.phone = `Use ${MAX_PHONE} characters or fewer.`;
  let email = '';
  const emailRaw = values.email.normalize('NFC').trim();
  if (!emailRaw) errors.email = 'Enter an email address.';
  else if (CONTROL.test(emailRaw)) errors.email = 'Enter an email address without line breaks.';
  else {
    try {
      email = normalizeEmail(emailRaw);
      if (email.length > MAX_EMAIL) errors.email = 'Enter an email address.';
    } catch (err) {
      errors.email = err instanceof EmailAddressError ? err.message : 'Enter an email address.';
    }
  }
  if (Object.keys(errors).length > 0 || !email) return { ok: false, errors };
  return { ok: true, person: { firstName, lastName, email, phone: phone.length === 0 ? null : phone } };
}

function findContact(
  db: Database.Database,
  person: Pick<ReadyContact, 'firstName' | 'lastName' | 'email'>,
): { id: number; first_name: string; last_name: string; phone: string | null } | undefined {
  return db
    .prepare(
      `SELECT id, first_name, last_name, phone FROM contacts
       WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE AND email_norm = ?`,
    )
    .get(person.firstName, person.lastName, person.email) as
    | { id: number; first_name: string; last_name: string; phone: string | null }
    | undefined;
}

function applyContact(db: Database.Database, person: ReadyContact, now: string): { status: 'added' | 'changed' | 'unchanged'; id: number } {
  const existing = findContact(db, person);
  if (!existing) {
    try {
      const inserted = db
        .prepare(
          `INSERT INTO contacts (first_name, last_name, email, email_norm, phone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(person.firstName, person.lastName, person.email, person.email, person.phone, now, now);
      return { status: 'added', id: Number(inserted.lastInsertRowid) };
    } catch (err) {
      if (!isUniqueConstraint(err)) throw err;
    }
  }
  const current = existing ?? findContact(db, person);
  if (!current) throw new Error('The contact could not be saved.');
  const phoneChanged = person.phone !== null && person.phone !== current.phone;
  const nameChanged = person.firstName !== current.first_name || person.lastName !== current.last_name;
  if (!phoneChanged && !nameChanged) return { status: 'unchanged', id: current.id };
  db.prepare(
    `UPDATE contacts
     SET first_name = ?, last_name = ?, email = ?, phone = COALESCE(?, phone), updated_at = ?
     WHERE id = ?`,
  ).run(person.firstName, person.lastName, person.email, person.phone, now, current.id);
  return { status: 'changed', id: current.id };
}

function parsePerson(cells: string[], columns: { first: number; last: number; email: number; phone: number }): ReadyContact | { code: ContactSkipCode } {
  const firstName = cellAt(cells, columns.first);
  const lastName = cellAt(cells, columns.last);
  const emailRaw = cellAt(cells, columns.email);
  const phoneRaw = cellAt(cells, columns.phone);
  if (!firstName || !lastName) return { code: 'n' };
  if (CONTROL.test(firstName) || CONTROL.test(lastName) || CONTROL.test(phoneRaw) || CONTROL.test(emailRaw)) return { code: 'c' };
  const first = capitalizeName(firstName);
  const last = capitalizeName(lastName);
  if (!first || !last) return { code: 'n' };
  if (first.length > MAX_NAME || last.length > MAX_NAME || `${first} ${last}`.length > MAX_NAME) return { code: 'l' };
  const phone = phoneRaw.length === 0 ? '' : formatPhone(phoneRaw);
  if (phoneRaw.length > MAX_PHONE || phone.length > MAX_PHONE) return { code: 'p' };
  try {
    const email = normalizeEmail(emailRaw);
    if (email.length > MAX_EMAIL) return { code: 'e' };
    return { firstName: first, lastName: last, email, phone: phone.length === 0 ? null : phone };
  } catch (err) {
    if (err instanceof EmailAddressError) return { code: 'e' };
    throw err;
  }
}

function cellAt(cells: string[], index: number): string {
  if (index < 0 || index >= cells.length) return '';
  return csvImportedCell(cells[index] ?? '');
}

function parseCsv(text: string): { line: number; cells: string[] }[] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let sawCell = false;

  const finishRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    cell = '';
    sawCell = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          sawCell = true;
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      cell += ch;
      sawCell = true;
      if (ch === '\n') line += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawCell = true;
      continue;
    }
    if (ch === ',') {
      cells.push(cell);
      cell = '';
      sawCell = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      finishRow();
      line += 1;
      rowLine = line;
      continue;
    }
    cell += ch;
    sawCell = true;
  }
  if (quoted) throw new Error(CONTACT_CSV_READ);
  if (sawCell || cells.length > 0) finishRow();
  return rows;
}

function isSkipCode(value: string): value is ContactSkipCode {
  return value === 'e' || value === 'n' || value === 'p' || value === 'l' || value === 'c';
}
