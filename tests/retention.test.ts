import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { exportShiftRoster } from '../src/export.js';
import { purgeLoginPayloads, runDueRetention, runRetention, startRetentionRunner } from '../src/jobs/retention.js';
import { purgeRateHits } from '../src/rate-limit.js';
import { formatUtc } from '../src/time.js';
import { devEnv } from './env.js';

const NOW = '2026-06-15T15:00:00.000Z';
const BEFORE = '2026-06-15T05:30:00.000Z';
const dirs: string[] = [];
const databases: { close: () => void }[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('retention cleanup', () => {
  it('clears signup details after the saved number of months and leaves a newer signup', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'pantry', 'America/Chicago');
    const oldShift = insertShift(db, eventId, '2024-06-01T16:00:00.000Z', '2024-06-01T17:00:00.000Z');
    const recentShift = insertShift(db, eventId, '2026-06-14T16:00:00.000Z', '2026-06-14T17:00:00.000Z');
    insertSignup(db, oldShift, 'Old Volunteer', 'old.volunteer@example.invalid', 1, 1);
    insertSignup(db, recentShift, 'New Volunteer', 'new.volunteer@example.invalid', 0, null);

    const result = runRetention(db, NOW);
    expect(result.signups).toBe(1);
    const old = signup(db, oldShift);
    expect(old).toMatchObject({
      name: null,
      email: null,
      email_norm: null,
      phone: null,
      is_minor: 0,
      guardian_name: null,
      guardian_email: null,
      notes: null,
      manage_token_hash: null,
      status: 'confirmed',
      attended: 1,
      anonymized_at: NOW,
    });
    expect(signup(db, recentShift).name).toBe('New Volunteer');
    const csv = exportShiftRoster(db, oldShift)?.csv ?? '';
    expect(csv).not.toContain('old.volunteer@example.invalid');
    expect(csv).not.toContain(',No,');
    expect(csv).toContain('Attended');
    expect(JSON.stringify(db.prepare('SELECT detail_json AS detail_json FROM audit').all())).not.toContain('@');
  });

  it('uses a shorter saved retention period', async () => {
    const db = await openDb();
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('retention_months', '1', ?)`).run(NOW);
    const eventId = insertEvent(db, 'pantry', 'America/Chicago');
    const dueShift = insertShift(db, eventId, '2026-04-01T16:00:00.000Z', '2026-04-01T17:00:00.000Z');
    const earlyShift = insertShift(db, eventId, '2026-06-01T16:00:00.000Z', '2026-06-01T17:00:00.000Z');
    const dueSignup = insertSignup(db, dueShift, 'Due Volunteer', 'due.volunteer@example.invalid', 0, null);
    insertSignup(db, earlyShift, 'Early Volunteer', 'early.volunteer@example.invalid', 0, null);
    insertOutbox(db, {
      dedupe: 'confirmation:v1:due:due.volunteer@example.invalid',
      signupId: dueSignup,
      shiftId: dueShift,
      kind: 'confirmation',
      to: 'due.volunteer@example.invalid',
      status: 'sent',
      createdAt: '2026-06-10T15:00:00.000Z',
      sentAt: '2026-06-10T15:00:00.000Z',
    });

    expect(runRetention(db, NOW).signups).toBe(1);
    expect(signup(db, dueShift).name).toBeNull();
    expect(signup(db, earlyShift).name).toBe('Early Volunteer');
    expect(db.prepare('SELECT to_email AS to_email, body_text AS body_text FROM outbox').get()).toEqual({
      to_email: '',
      body_text: '',
    });
  });

  it('clears old mail, expired sign-in records, audit notes, and rate-limit counters', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'pantry', 'America/Chicago');
    const shiftId = insertShift(db, eventId, '2026-06-14T16:00:00.000Z', '2026-06-14T17:00:00.000Z');
    const signupId = insertSignup(db, shiftId, 'Mail Volunteer', 'mail.volunteer@example.invalid', 0, null);
    insertOutbox(db, {
      dedupe: 'confirmation:v1:1:mail.volunteer@example.invalid',
      signupId,
      shiftId,
      kind: 'confirmation',
      to: 'mail.volunteer@example.invalid',
      status: 'sent',
      createdAt: '2026-05-01T15:00:00.000Z',
      sentAt: '2026-05-01T15:00:00.000Z',
    });
    insertOutbox(db, {
      dedupe: 'confirmation:v2:1:mail.volunteer@example.invalid',
      signupId,
      shiftId,
      kind: 'confirmation',
      to: 'mail.volunteer@example.invalid',
      status: 'sent',
      createdAt: '2026-06-14T15:00:00.000Z',
      sentAt: '2026-06-14T15:00:00.000Z',
    });
    const expiredHash = 'ab'.repeat(32);
    const liveHash = 'cd'.repeat(32);
    insertOutbox(db, {
      dedupe: `magic_link:${expiredHash}`,
      signupId: null,
      shiftId: null,
      kind: 'magic_link',
      to: 'coordinator@example.invalid',
      status: 'pending',
      createdAt: NOW,
      sentAt: null,
    });
    insertOutbox(db, {
      dedupe: `magic_link:${liveHash}`,
      signupId: null,
      shiftId: null,
      kind: 'magic_link',
      to: 'coordinator@example.invalid',
      status: 'pending',
      createdAt: NOW,
      sentAt: null,
    });
    db.prepare(
      `INSERT INTO login_tokens (token_hash, coordinator_id, expires_at, used_at, created_at)
       VALUES (?, 1, ?, NULL, ?)`,
    ).run(expiredHash, '2026-06-15T14:00:00.000Z', NOW);
    db.prepare(
      `INSERT INTO login_tokens (token_hash, coordinator_id, expires_at, used_at, created_at)
       VALUES (?, 1, ?, NULL, ?)`,
    ).run(liveHash, '2026-06-15T16:00:00.000Z', NOW);
    db.prepare(
      `INSERT INTO sessions (id_hash, coordinator_id, csrf, expires_at, created_at, last_seen_at)
       VALUES ('expired-session', 1, 'csrf-expired', ?, ?, ?),
              ('live-session', 1, 'csrf-live', '2026-06-20T15:00:00.000Z', ?, ?)`,
    ).run(BEFORE, NOW, NOW, NOW, NOW);
    db.prepare(`INSERT INTO audit (coordinator_id, action, detail_json, at) VALUES (NULL, 'login', '{}', ?)`).run(
      '2024-05-01T15:00:00.000Z',
    );
    db.prepare(`INSERT INTO audit (coordinator_id, action, detail_json, at) VALUES (NULL, 'login', '{}', ?)`).run(NOW);
    db.prepare(`INSERT INTO rate_hits (key, window_start, count) VALUES ('old', ?, 1), ('new', ?, 1)`).run(
      '2026-06-01T15:00:00.000Z',
      NOW,
    );

    const result = runRetention(db, NOW);
    expect(result.messages).toBe(2);
    expect(result.sessions).toBe(1);
    expect(result.loginTokens).toBe(1);
    expect(result.auditRows).toBe(1);
    expect(result.rateHits).toBe(1);
    const rows = db
      .prepare('SELECT dedupe_key, to_email, subject, body_text, body_html, headers_json, status FROM outbox ORDER BY id')
      .all() as Array<{
      dedupe_key: string;
      to_email: string;
      subject: string;
      body_text: string;
      body_html: string;
      headers_json: string;
      status: string;
    }>;
    expect(rows[0]).toMatchObject({ dedupe_key: 'purged:1', to_email: '', subject: '', body_text: '', status: 'sent' });
    expect(rows[1]?.to_email).toBe('mail.volunteer@example.invalid');
    expect(rows[2]).toMatchObject({ dedupe_key: 'purged:3', to_email: '', status: 'cancelled' });
    expect(rows[3]?.dedupe_key).toBe(`magic_link:${liveHash}`);
    expect(rows[3]?.to_email).toBe('coordinator@example.invalid');
    expect(db.prepare('SELECT id_hash FROM sessions').all()).toEqual([{ id_hash: 'live-session' }]);
    expect(db.prepare('SELECT token_hash FROM login_tokens').all()).toEqual([{ token_hash: liveHash }]);
    expect(db.prepare(`SELECT action FROM audit WHERE action = 'login'`).all()).toEqual([{ action: 'login' }]);
    expect(db.prepare('SELECT key FROM rate_hits').all()).toEqual([{ key: 'new' }]);
    expect(JSON.stringify(rows.filter((row) => row.to_email === ''))).not.toContain('@');
  });

  it('clears an expired sign-in message before 1:00 AM', async () => {
    const db = await openDb();
    const hash = 'ef'.repeat(32);
    insertOutbox(db, {
      dedupe: `magic_link:${hash}`,
      signupId: null,
      shiftId: null,
      kind: 'magic_link',
      to: 'coordinator@example.invalid',
      status: 'pending',
      createdAt: BEFORE,
      sentAt: null,
    });
    db.prepare(
      `INSERT INTO login_tokens (token_hash, coordinator_id, expires_at, used_at, created_at) VALUES (?, 1, ?, NULL, ?)`,
    ).run(hash, '2026-06-15T05:00:00.000Z', BEFORE);

    expect(purgeLoginPayloads(db, BEFORE).messages).toBe(1);
    expect(db.prepare('SELECT to_email AS to_email, status AS status FROM outbox').get()).toEqual({
      to_email: '',
      status: 'cancelled',
    });
    expect(purgeRateHits(db, BEFORE)).toBe(0);
  });

  it('waits for 1:00 AM Central Time, runs once when that hour repeats, and skips a bad time zone', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'pantry', 'America/Chicago');
    const shiftId = insertShift(db, eventId, '2024-06-01T16:00:00.000Z', '2024-06-01T17:00:00.000Z');
    insertSignup(db, shiftId, 'Clock Volunteer', 'clock.volunteer@example.invalid', 0, null);
    const broken = insertEvent(db, 'broken', 'Not/AZone');
    const brokenShift = insertShift(db, broken, '2024-06-01T16:00:00.000Z', '2024-06-01T17:00:00.000Z');
    insertSignup(db, brokenShift, 'Broken Volunteer', 'broken.volunteer@example.invalid', 0, null);

    expect(runDueRetention(db, BEFORE)).toMatchObject({ ran: false });
    expect(signup(db, shiftId).name).toBe('Clock Volunteer');

    const errors: string[] = [];
    const write = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    let due: ReturnType<typeof runDueRetention>;
    try {
      due = runDueRetention(db, NOW);
    } finally {
      console.error = write;
    }
    expect(due.ran).toBe(true);
    expect(due.result.signups).toBe(1);
    expect(signup(db, brokenShift).name).toBe('Broken Volunteer');
    expect(errors.join(' ')).toContain('not valid');
    expect(errors.join(' ')).not.toContain('@');
    expect(runDueRetention(db, NOW).ran).toBe(false);

    const fall = await openDb();
    const fallEvent = insertEvent(fall, 'pantry', 'America/Chicago');
    const fallShift = insertShift(fall, fallEvent, '2024-06-01T16:00:00.000Z', '2024-06-01T17:00:00.000Z');
    insertSignup(fall, fallShift, 'Fall Volunteer', 'fall.volunteer@example.invalid', 0, null);
    const firstHour = localUtc('2026-11-01', 1, 0, 'earlier');
    const secondHour = localUtc('2026-11-01', 1, 30, 'later');
    expect(runDueRetention(fall, firstHour).ran).toBe(true);
    expect(runDueRetention(fall, secondHour).ran).toBe(false);
    expect(fall.prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE job = 'retention'`).get()).toEqual({ n: 1 });
  });

  it('runs the daily cleanup on the first check after 1:00 AM', async () => {
    const db = await openDb();
    const eventId = insertEvent(db, 'pantry', 'America/Chicago');
    const shiftId = insertShift(db, eventId, '2024-06-01T16:00:00.000Z', '2024-06-01T17:00:00.000Z');
    insertSignup(db, shiftId, 'Runner Volunteer', 'runner.volunteer@example.invalid', 0, null);
    const runner = startRetentionRunner(db, () => NOW);
    expect(signup(db, shiftId).name).toBeNull();
    runner.stop();
  });
});

function localUtc(date: string, hour: number, minute: number, disambiguation: 'earlier' | 'later'): string {
  const [year, month, day] = date.split('-').map(Number);
  const zoned = Temporal.ZonedDateTime.from(
    { timeZone: 'America/Chicago', year, month, day, hour, minute, second: 0, millisecond: 0 },
    { disambiguation },
  );
  return formatUtc(zoned.toInstant());
}

async function openDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-retention-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  db.prepare(
    `INSERT INTO coordinators (email, name, role, active, created_at) VALUES ('coordinator@example.invalid', 'Coordinator', 'admin', 1, ?)`,
  ).run(NOW);
  return db;
}

function insertEvent(db: Awaited<ReturnType<typeof openDb>>, slug: string, tz: string): number {
  return Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES (?, ?, '', 'Sioux Center, Iowa', ?, 1, ?)`,
    ).run(slug, slug, tz, NOW).lastInsertRowid,
  );
}

function insertShift(db: Awaited<ReturnType<typeof openDb>>, eventId: number, starts: string, ends: string): number {
  return Number(
    db.prepare(
      `INSERT INTO shifts (
         event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
       ) VALUES (?, 'Sorting', ?, ?, 4, '', 0, 1, 1)`,
    ).run(eventId, starts, ends).lastInsertRowid,
  );
}

function insertSignup(
  db: Awaited<ReturnType<typeof openDb>>,
  shiftId: number,
  name: string,
  email: string,
  isMinor: number,
  attended: number | null,
): number {
  return Number(
    db.prepare(
      `INSERT INTO signups (
         shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
         group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
         attended, created_at, updated_at, anonymized_at
       ) VALUES (?, ?, ?, ?, '555-0100', ?, ?, ?, 1, 'Bring a pen', 'confirmed', ?, ?, 0, ?, ?, ?, NULL)`,
    ).run(
      shiftId,
      name,
      email,
      email.toLowerCase(),
      isMinor,
      isMinor ? 'Guardian Pat' : null,
      isMinor ? 'guardian.pat@example.invalid' : null,
      `hash-${email}`,
      '2026-06-20T15:00:00.000Z',
      attended,
      NOW,
      NOW,
    ).lastInsertRowid,
  );
}

function insertOutbox(
  db: Awaited<ReturnType<typeof openDb>>,
  row: {
    dedupe: string;
    signupId: number | null;
    shiftId: number | null;
    kind: string;
    to: string;
    status: string;
    createdAt: string;
    sentAt: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO outbox (
       dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
       headers_json, send_after, attempts, status, created_at, sent_at
     ) VALUES (?, ?, ?, ?, ?, 'Subject line', 'Body with a private link', '<p>Body</p>', ?, ?, 1, ?, ?, ?)`,
  ).run(
    row.dedupe,
    row.signupId,
    row.shiftId,
    row.kind,
    row.to,
    JSON.stringify({ 'Reply-To': row.to }),
    row.createdAt,
    row.status,
    row.createdAt,
    row.sentAt,
  );
}

function signup(db: Awaited<ReturnType<typeof openDb>>, shiftId: number) {
  return db.prepare('SELECT * FROM signups WHERE shift_id = ?').get(shiftId) as {
    name: string | null;
    email: string | null;
    email_norm: string | null;
    phone: string | null;
    is_minor: number;
    guardian_name: string | null;
    guardian_email: string | null;
    notes: string | null;
    manage_token_hash: string | null;
    status: string;
    attended: number | null;
    anonymized_at: string | null;
  };
}
