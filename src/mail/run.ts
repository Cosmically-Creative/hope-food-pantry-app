import type Database from 'better-sqlite3';
import { deliverDueMail } from './deliver.js';
import type { Mailer } from './types.js';

const INTERVAL_MS = 30_000;

/**
 * One in-process pass every 30 seconds. A pass that is still running is not started again.
 * Already accepted mail cannot be recalled.
 */
export function startOutboxRunner(db: Database.Database, mailer: Mailer, now: () => string): { stop: () => void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    void deliverDueMail(db, mailer, now())
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : 'Mail delivery failed.');
      })
      .finally(() => {
        running = false;
      });
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
