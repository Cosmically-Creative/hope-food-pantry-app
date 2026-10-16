import type Database from 'better-sqlite3';
import { expandTemplates } from '../recurrence.js';
import { formatInstantInZone } from '../time.js';

/** Local time after which that event's day gets its weekly fill. */
export const REFILL_LOCAL_TIME = '01:00';

const JOB = 'template.expand';
const INTERVAL_MS = 60 * 1000;

export type DailyExpandResult = {
  zones: string[];
  created: number;
  skipped: string[];
};

/**
 * Fills active weekly templates once each local date, after 01:00 in that
 * event's time zone. A restart later the same day still fills if that date
 * has not been recorded. The check uses the clock, not a 24-hour timer.
 */
export function runDueTemplateExpansion(db: Database.Database, now: string): DailyExpandResult {
  const zones = db.prepare('SELECT DISTINCT tz AS tz FROM events ORDER BY tz').all() as { tz: string }[];
  const ran: string[] = [];
  let created = 0;
  const skipped: string[] = [];
  for (const zone of zones) {
    let date = '';
    let time = '';
    try {
      const clock = formatInstantInZone(now, zone.tz);
      date = clock.date;
      time = clock.time24;
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Weekly refill could not read an event time zone.');
      continue;
    }
    if (time < REFILL_LOCAL_TIME || alreadyRan(db, zone.tz, date)) continue;
    try {
      const result = expandTemplates(db, now, { timeZone: zone.tz });
      markRan(db, zone.tz, date, now);
      created += result.created;
      skipped.push(...result.skipped);
      ran.push(zone.tz);
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Weekly refill failed.');
    }
  }
  return { zones: ran, created, skipped };
}

/** Checks about once a minute. A check that is still running is not started again. */
export function startDailyExpansionRunner(db: Database.Database, now: () => string): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = runDueTemplateExpansion(db, now());
      if (result.created > 0) {
        console.log(`Added ${result.created} weekly shifts for the next eight weeks.`);
      }
      for (const skip of result.skipped) console.error(skip);
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Weekly refill failed.');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function alreadyRan(db: Database.Database, timeZone: string, localDate: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM job_runs WHERE job = ? AND scope = ? AND local_date = ?').get(JOB, timeZone, localDate);
  return row !== undefined;
}

function markRan(db: Database.Database, timeZone: string, localDate: string, now: string): void {
  db.prepare('INSERT INTO job_runs (job, scope, local_date, ran_at) VALUES (?, ?, ?, ?)').run(JOB, timeZone, localDate, now);
}
