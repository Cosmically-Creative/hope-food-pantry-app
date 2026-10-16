import type Database from 'better-sqlite3';
import type { MailIdentity } from './mail/types.js';
import { queueDueReminders } from './reminders.js';

const INTERVAL_MS = 5 * 60 * 1000;

/** One reminder pass every five minutes. A pass that is still running is not started again. */
export function startReminderRunner(
  db: Database.Database,
  mail: MailIdentity,
  secret: string,
  now: () => string,
): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    try {
      queueDueReminders(db, mail, secret, now());
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Reminder queue failed.');
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
