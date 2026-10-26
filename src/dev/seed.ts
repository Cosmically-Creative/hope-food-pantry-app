import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { openAppDatabase } from '../db.js';
import { normalizeEmail } from '../email.js';
import { loadConfig } from '../config.js';
import {
  addLocalDays,
  localShiftToUtc,
  nowUtc,
  todayInZone,
  weekdayIndex,
} from '../time.js';

export const SEED_EMAIL_DOMAIN = 'example.invalid';

export type SeedResult = {
  eventId: number;
  slug: string;
  templateId: number;
  shiftIds: number[];
  signupIds: number[];
};

export function assertDevelopmentSeed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed because NODE_ENV=production. Seed data is fake and is only for local development.',
    );
  }
}

export function seedDevelopment(
  db: Database.Database,
  config: AppConfig,
  options?: { today?: string },
): SeedResult {
  if (config.nodeEnv === 'production') {
    throw new Error(
      'Refusing to seed because NODE_ENV=production. Seed data is fake and is only for local development.',
    );
  }
  const existing = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  if (existing.n > 0) {
    throw new Error(
      'Refusing to seed because this database already has events. Delete the development database file if you want a fresh seed.',
    );
  }

  const timeZone = config.defaultTimeZone;
  const today = options?.today ?? todayInZone(timeZone);
  const createdAt = nowUtc();
  const weekday = weekdayIndex(today, timeZone);
  const shiftDates = [1, 3, 6].map((days) => addLocalDays(today, days));
  const roles = ['Sorting', 'Distribution', 'Intake'] as const;
  const capacities = [3, 4, 2] as const;

  const insert = db.transaction((): SeedResult => {
    const event = db
      .prepare(
        `INSERT INTO events (slug, title, description, location, tz, published, created_at)
         VALUES ('weekly-pantry', 'Weekly pantry', '', '', ?, 1, ?)`,
      )
      .run(timeZone, createdAt);
    const eventId = insertId(event);
    const template = db
      .prepare(
        `INSERT INTO shift_templates (
           event_id, role, weekday, start_local, end_local, capacity, starts_on, ends_on, active, revision
         ) VALUES (?, 'Sorting', ?, '09:00', '12:00', 6, ?, NULL, 1, 1)`,
      )
      .run(eventId, weekday, today);
    const templateId = insertId(template);
    const shiftIds: number[] = [];
    for (let index = 0; index < shiftDates.length; index += 1) {
      const date = shiftDates[index];
      const role = roles[index];
      const capacity = capacities[index];
      if (!date || !role || !capacity) throw new Error('Seed shift list is incomplete.');
      const times = localShiftToUtc(date, '09:00', '12:00', timeZone);
      const shift = db
        .prepare(
          `INSERT INTO shifts (
             event_id, template_id, occurrence_date, template_revision, role,
             starts_at_utc, ends_at_utc, capacity, notes, cancelled, manually_modified, version
           ) VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, 'Development seed. Not a real pantry shift.', 0, 0, 1)`,
        )
        .run(eventId, role, times.startsAtUtc, times.endsAtUtc, capacity);
      shiftIds.push(insertId(shift));
    }
    const firstShift = shiftIds[0];
    if (firstShift === undefined) throw new Error('Seed did not create a shift.');
    const signupIds = insertFakeSignups(db, firstShift, createdAt);
    return { eventId, slug: 'weekly-pantry', templateId, shiftIds, signupIds };
  });
  return insert();
}

export async function runSeedCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertDevelopmentSeed(env);
  const config = loadConfig(env);
  const db = await openAppDatabase(config);
  try {
    const result = seedDevelopment(db, config);
    console.log('Seeded fake development data.');
    console.log(`Database: ${config.databaseFile}`);
    console.log(
      `Event ${result.slug}: ${result.shiftIds.length} one-off shifts and ${result.signupIds.length} fake signups.`,
    );
    console.log('Each signup is one person. Another person can use the same email. Group size is fixed at 1.');
    console.log('The weekly template is stored. Starting the app adds its shifts for the next eight weeks.');
    console.log('No coordinator account was created.');
  } finally {
    db.close();
  }
}

function insertFakeSignups(db: Database.Database, shiftId: number, createdAt: string): number[] {
  // TODO(D2): These rows are individual signups. Do not invent group reservations here.
  // TODO(D4): Seed data does not create coordinator accounts.
  const people = [
    {
      name: 'Fake Volunteer Ada',
      email: `ada.fake@${SEED_EMAIL_DOMAIN}`,
      phone: '712-555-0101',
      notes: 'Fake note for development.',
      status: 'confirmed',
    },
    {
      name: 'Fake Volunteer Ben',
      email: `ben.fake@${SEED_EMAIL_DOMAIN}`,
      phone: '712-555-0102',
      notes: null,
      status: 'confirmed',
    },
    {
      name: 'Fake Volunteer Cam',
      email: `cam.fake@${SEED_EMAIL_DOMAIN}`,
      phone: null,
      notes: null,
      status: 'cancelled',
    },
  ];
  const statement = db.prepare(
    `INSERT INTO signups (
       shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
       group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
       attended, created_at, updated_at, anonymized_at
     ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 1, ?, ?, NULL, NULL, 0, NULL, ?, ?, NULL)`,
  );
  return people.map((person) =>
    insertId(
      statement.run(
        shiftId,
        person.name,
        person.email,
        normalizeEmail(person.email),
        person.phone,
        person.notes,
        person.status,
        createdAt,
        createdAt,
      ),
    ),
  );
}

function insertId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid);
}
