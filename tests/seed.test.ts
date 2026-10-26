import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openAppDatabase } from '../src/db.js';
import { runSeedCli, SEED_EMAIL_DOMAIN, seedDevelopment } from '../src/dev/seed.js';
import { localToUtc, weekdayIndex } from '../src/time.js';
import { devEnv, productionEnv } from './env.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('development seed', () => {
  it('refuses production before creating a database', async () => {
    await expect(runSeedCli({ NODE_ENV: 'production' })).rejects.toThrow(/Refusing to seed/);
    const config = loadConfig(productionEnv('/tmp/hope-should-not-matter'));
    expect(() => seedDevelopment({} as never, config)).toThrow(/Refusing to seed/);
  });

  it('inserts one event, one template, one-off shifts, and fake signups', async () => {
    const dataDir = path.join(mkdtempSync(path.join(tmpdir(), 'hope-volunteer-')), 'data');
    dirs.push(path.dirname(dataDir));
    const config = loadConfig(devEnv({ DATA_DIR: dataDir }));
    const db = await openAppDatabase(config);
    try {
      const result = seedDevelopment(db, config, { today: '2026-10-14' });
      expect(result.slug).toBe('weekly-pantry');
      expect(result.shiftIds).toHaveLength(3);
      expect(result.signupIds).toHaveLength(3);
      const template = db
        .prepare('SELECT weekday, starts_on, start_local, end_local, capacity FROM shift_templates')
        .get();
      expect(template).toEqual({
        weekday: weekdayIndex('2026-10-14', 'America/Chicago'),
        starts_on: '2026-10-14',
        start_local: '09:00',
        end_local: '12:00',
        capacity: 6,
      });
      const shifts = db
        .prepare('SELECT role, template_id, starts_at_utc, capacity FROM shifts ORDER BY starts_at_utc, role')
        .all() as { role: string; template_id: number | null; starts_at_utc: string; capacity: number }[];
      expect(shifts.map((shift) => shift.role)).toEqual(['Sorting', 'Distribution', 'Intake']);
      expect(shifts.every((shift) => shift.template_id === null)).toBe(true);
      expect(shifts[0]?.starts_at_utc).toBe(localToUtc('2026-10-15', '09:00', 'America/Chicago'));
      const signups = db
        .prepare('SELECT email, email_norm, group_size, is_minor, guardian_email, status FROM signups ORDER BY email')
        .all() as {
        email: string;
        email_norm: string;
        group_size: number;
        is_minor: number;
        guardian_email: string | null;
        status: string;
      }[];
      expect(signups).toHaveLength(3);
      for (const signup of signups) {
        expect(signup.email.endsWith(`@${SEED_EMAIL_DOMAIN}`)).toBe(true);
        expect(signup.group_size).toBe(1);
        expect(signup.is_minor).toBe(0);
        expect(signup.guardian_email).toBeNull();
      }
      expect(signups.some((signup) => signup.status === 'cancelled')).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM coordinators').get()).toEqual({ n: 0 });
      expect(() => seedDevelopment(db, config, { today: '2026-10-14' })).toThrow(/already has events/);
    } finally {
      db.close();
    }
  });
});
