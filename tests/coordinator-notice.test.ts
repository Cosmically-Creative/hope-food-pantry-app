import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveSignup, switchSignup, updateShift } from '../src/admin/store.js';
import { deactivateAdmin } from '../src/admins.js';
import { recoverCoordinator } from '../src/auth/recover.js';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { deliverDueMail } from '../src/mail/deliver.js';
import type { Mailer } from '../src/mail/types.js';
import { cancelSignup, reserveSignup, type ReserveInput } from '../src/signup.js';
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

describe('coordinator roster notices', () => {
  it('tells each active coordinator when someone signs up, and does not repeat that notice', async () => {
    const { db, shiftId } = await buildDb();
    insertCoordinator(db, 'ada@example.invalid', 'Ada Admin', 1, 'admin');
    insertCoordinator(db, 'bea@example.invalid', 'Bea Coordinator', 1, 'coordinator');
    insertCoordinator(db, 'cam@example.invalid', 'Cam Inactive', 0, 'admin');
    const saved = reserveSignup(db, reservation(shiftId, {
      name: 'Pat <script>\nReview',
      email: 'pat@example.invalid',
      phone: '712-555-0199',
      groupSize: 3,
    }));
    expect(saved.ok).toBe(true);

    const notices = db
      .prepare(`SELECT to_email, subject, body_text, body_html, status FROM outbox WHERE kind = 'notice' ORDER BY to_email`)
      .all() as Array<{ to_email: string; subject: string; body_text: string; body_html: string; status: string }>;
    expect(notices.map((row) => row.to_email)).toEqual(['ada@example.invalid', 'bea@example.invalid']);
    expect(notices[0]).toEqual(expect.objectContaining({
      status: 'pending',
      subject: 'Pat <script> Review signed up for Sorting',
    }));
    expect(notices[0]?.subject).not.toContain('\n');
    const letter = notices[0];
    if (!letter) throw new Error('Ada did not get a notice.');
    expect(letter.body_html).toContain('Hello Ada Admin,');
    expect(letter.body_html).toContain('Pat &lt;script&gt; Review');
    expect(letter.body_html).not.toContain('<script>');
    expect(letter.body_text).toContain('pat@example.invalid');
    expect(letter.body_text).toContain('712-555-0199');
    expect(letter.body_text).toContain('This signup holds 3 spots.');
    expect(letter.body_text).toContain(`http://127.0.0.1:3000/admin/shifts/${shiftId}`);
    expect(letter.body_text).not.toContain('/m/');
    expect(letter.body_html).not.toContain('/m/');
    expect(db.prepare(`SELECT body_text AS body_text FROM outbox WHERE kind = 'confirmation'`).get()).toEqual(
      expect.objectContaining({ body_text: expect.stringContaining('/m/') }),
    );

    const again = reserveSignup(db, reservation(shiftId, {
      name: 'Pat <script>\nReview',
      email: 'pat@example.invalid',
      phone: '712-555-0199',
      groupSize: 3,
      operationId: 'same-operation',
    }));
    expect(again.ok && again.replay).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'notice'`).get()).toEqual({ n: 2 });
  });

  it('tells coordinators about a cancellation without dropping the signup notice', async () => {
    const { db, shiftId } = await buildDb();
    insertCoordinator(db, 'ada@example.invalid', 'Ada Admin', 1);
    const saved = reserveSignup(db, reservation(shiftId));
    if (!saved.ok || !saved.manageToken) throw new Error('Signup was not saved.');
    expect(cancelSignup(db, saved.manageToken, NOW, MAIL)).toEqual({ ok: true, already: false });
    const notices = db.prepare(`SELECT subject, status FROM outbox WHERE kind = 'notice' ORDER BY subject`).all();
    expect(notices).toEqual([
      { subject: 'Pat Review signed up for Sorting', status: 'pending' },
      { subject: "Pat Review's signup for Sorting was cancelled", status: 'pending' },
    ]);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'confirmation'`).get()).toEqual({ status: 'cancelled' });
    expect(cancelSignup(db, saved.manageToken, NOW, MAIL)).toEqual({ ok: true, already: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'notice'`).get()).toEqual({ n: 2 });
  });

  it('tells coordinators when a signup is switched, moved, or the shift changes', async () => {
    const { db, eventId, shiftId } = await buildDb();
    const ada = insertCoordinator(db, 'ada@example.invalid', 'Ada Admin', 1);
    const other = insertShift(db, eventId, 'Distribution');
    const saved = reserveSignup(db, reservation(shiftId, { email: 'pat@example.invalid', operationId: 'switch-source' }));
    if (!saved.ok) throw new Error('Signup was not saved.');
    const switched = switchSignup(db, saved.signupId, other, 'switch-op', NOW, MAIL);
    expect(switched.ok).toBe(true);
    const switchNotice = db.prepare(`SELECT body_text AS body_text FROM outbox WHERE kind = 'notice' AND subject = 'Pat Review switched to Distribution'`).get() as { body_text: string };
    expect(switchNotice.body_text).toContain('switched from Sorting (');
    expect(switchNotice.body_text).toContain('to Distribution');
    expect(switchNotice.body_text).toContain(`/admin/shifts/${other}`);
    expect(switchNotice.body_text).not.toContain('/m/');

    const movedSource = reserveSignup(db, reservation(shiftId, { name: 'Sam Example', email: 'sam@example.invalid', operationId: 'move-source' }));
    if (!movedSource.ok) throw new Error('Move signup was not saved.');
    const moved = moveSignup(db, ada, movedSource.signupId, other, 'move-op', NOW, MAIL);
    expect(moved.ok).toBe(true);
    const moveNotice = db.prepare(`SELECT body_text AS body_text FROM outbox WHERE kind = 'notice' AND subject = 'Sam Example was moved to Distribution'`).get() as { body_text: string };
    expect(moveNotice.body_text).toContain('was moved from Sorting (');
    expect(moveNotice.body_text).toContain('to Distribution');

    const changed = updateShift(db, ada, other, {
      role: 'Packing',
      date: '2026-10-15',
      start: '10:00',
      end: '13:00',
      capacity: 4,
    }, NOW, MAIL);
    expect(changed.ok).toBe(true);
    const changeNotices = db.prepare(`SELECT subject AS subject FROM outbox WHERE kind = 'notice' AND subject LIKE '%shift changed' ORDER BY subject`).all();
    expect(changeNotices).toEqual([
      { subject: "Pat Review's Packing shift changed" },
      { subject: "Sam Example's Packing shift changed" },
    ]);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'notice' AND subject = 'Pat Review signed up for Sorting'`).get()).toEqual({
      status: 'pending',
    });
  });

  it('sends a signup notice after the person cancels, and does not send it once the coordinator or the signup is gone', async () => {
    const { db, shiftId } = await buildDb();
    insertCoordinator(db, 'ada@example.invalid', 'Ada Admin', 1);
    const saved = reserveSignup(db, reservation(shiftId));
    if (!saved.ok || !saved.manageToken) throw new Error('Signup was not saved.');
    cancelSignup(db, saved.manageToken, NOW, MAIL);
    const sent: string[] = [];
    const mailer: Mailer = {
      async send(message) {
        sent.push(message.subject);
        return { result: 'sent', providerId: 'notice-1' };
      },
    };
    expect(await deliverDueMail(db, mailer, NOW)).toBe(3);
    expect(sent).toEqual([
      'Pat Review signed up for Sorting',
      'Your signup for Sorting is cancelled',
      "Pat Review's signup for Sorting was cancelled",
    ]);
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'notice' AND subject = 'Pat Review signed up for Sorting'`).get()).toEqual({
      status: 'sent',
    });

    const quiet = await buildDb();
    insertCoordinator(quiet.db, 'ada@example.invalid', 'Ada Admin', 1);
    reserveSignup(quiet.db, reservation(quiet.shiftId, { operationId: 'quiet-operation' }));
    quiet.db.prepare(`UPDATE coordinators SET active = 0 WHERE email = 'ada@example.invalid'`).run();
    const calls: string[] = [];
    expect(await deliverDueMail(quiet.db, { async send(message) { calls.push(message.to); return { result: 'sent', providerId: null }; } }, NOW)).toBe(1);
    expect(calls).toEqual(['pat.review@example.invalid']);
    expect(quiet.db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'notice'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'That coordinator no longer has access.',
    });

    const forgotten = await buildDb();
    insertCoordinator(forgotten.db, 'ada@example.invalid', 'Ada Admin', 1);
    const old = reserveSignup(forgotten.db, reservation(forgotten.shiftId, { operationId: 'old-operation' }));
    if (!old.ok) throw new Error('Old signup was not saved.');
    forgotten.db.prepare(
      `UPDATE signups
       SET name = NULL, email = NULL, email_norm = NULL, phone = NULL, is_minor = 0,
           guardian_name = NULL, guardian_email = NULL, notes = NULL,
           manage_token_hash = NULL, token_expires_at = NULL,
           anonymized_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(NOW, NOW, old.signupId);
    let anonymizedCalls = 0;
    expect(await deliverDueMail(forgotten.db, { async send() { anonymizedCalls += 1; return { result: 'sent', providerId: null }; } }, NOW)).toBe(0);
    expect(anonymizedCalls).toBe(0);
    expect(forgotten.db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'notice'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'The signup is no longer available.',
    });
  });

  it('stops a waiting notice when an administrator is removed or the sign-in address is replaced', async () => {
    const { db, shiftId } = await buildDb();
    const ada = insertCoordinator(db, 'ada@example.invalid', 'Ada Admin', 1);
    const bea = insertCoordinator(db, 'bea@example.invalid', 'Bea Admin', 1);
    reserveSignup(db, reservation(shiftId));
    expect(deactivateAdmin(db, ada, bea, NOW)).toEqual({ ok: true });
    expect(db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'notice' AND to_email = 'bea@example.invalid'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'That coordinator no longer has access.',
    });
    expect(db.prepare(`SELECT status FROM outbox WHERE kind = 'notice' AND to_email = 'ada@example.invalid'`).get()).toEqual({
      status: 'pending',
    });

    recoverCoordinator(db, { email: 'ada@example.invalid', replaceWith: 'ada.next@example.invalid', now: NOW });
    expect(db.prepare(`SELECT status, last_error FROM outbox WHERE kind = 'notice' AND to_email = 'ada@example.invalid'`).get()).toEqual({
      status: 'cancelled',
      last_error: 'That coordinator no longer has access.',
    });
  });
});

async function buildDb() {
  const root = mkdtempSync(path.join(tmpdir(), 'hope-notice-'));
  dirs.push(root);
  const config = loadConfig(devEnv({ DATA_DIR: path.join(root, 'data') }));
  const db = await openAppDatabase(config);
  databases.push(db);
  const eventId = Number(
    db.prepare(
      `INSERT INTO events (slug, title, description, location, tz, published, created_at)
       VALUES ('weekly-pantry', 'Weekly pantry', 'Bring a hat.', 'Sioux Center, Iowa', 'America/Chicago', 1, ?)`,
    ).run(NOW).lastInsertRowid,
  );
  return { db, eventId, shiftId: insertShift(db, eventId, 'Sorting') };
}

function insertShift(db: Awaited<ReturnType<typeof openAppDatabase>>, eventId: number, role: string): number {
  return Number(
    db.prepare(
      `INSERT INTO shifts (event_id, role, starts_at_utc, ends_at_utc, capacity, notes, cancelled)
       VALUES (?, ?, '2026-10-15T14:00:00.000Z', '2026-10-15T17:00:00.000Z', 4, '', 0)`,
    ).run(eventId, role).lastInsertRowid,
  );
}

function insertCoordinator(
  db: Awaited<ReturnType<typeof openAppDatabase>>,
  email: string,
  name: string,
  active: number,
  role: 'admin' | 'coordinator' = 'admin',
): number {
  return Number(
    db.prepare(
      `INSERT INTO coordinators (email, name, role, password_hash, active, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(email, name, role, active, NOW).lastInsertRowid,
  );
}

function reservation(shiftId: number, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    shiftId,
    name: 'Pat Review',
    email: 'pat.review@example.invalid',
    phone: '712-555-0100',
    notes: null,
    operationId: 'same-operation',
    now: NOW,
    mail: MAIL,
    ...overrides,
  };
}
