import { recoverCoordinator } from './auth/recover.js';
import { loadConfig } from './config.js';
import { openAppDatabase } from './db.js';
import { nowUtc } from './time.js';

/**
 * Host recovery command. In the container:
 *   docker compose exec hope-volunteer node dist/recover-coordinator.js <current-email> [--replace <new-email>]
 * The container already has its configuration, so no --env-file is needed there.
 */

// Same as the server: the database is owner-only.
process.umask(0o077);

const args = process.argv.slice(2);
const email = args[0] ?? '';
const replaceFlag = args.indexOf('--replace');
const replaceWith = replaceFlag === -1 ? undefined : args[replaceFlag + 1];

if (!email || email.startsWith('--') || (replaceFlag !== -1 && (!replaceWith || replaceWith.startsWith('--')))) {
  console.error('Usage: node dist/recover-coordinator.js <current-email> [--replace <new-email>]');
  process.exit(1);
}

const config = loadConfig(process.env);
const db = await openAppDatabase(config);
try {
  const result = recoverCoordinator(db, { email, replaceWith, now: nowUtc() });
  const verb = replaceWith ? 'Updated the sign-in address and revoked old sessions' : 'Revoked sessions and unused sign-in links';
  console.log(`${verb} for coordinator ${result.coordinatorId}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
