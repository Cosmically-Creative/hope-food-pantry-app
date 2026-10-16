// Spawned with `node --import tsx`. Those .ts specifiers are intentional.
// tsconfig excludes this file because tsc does not allow that import style.
import { openDatabaseFile } from '../src/db.ts';
import { reserveSignup, type ReserveInput } from '../src/signup.ts';

const data = JSON.parse(process.env.HOPE_RACE ?? '') as { databaseFile: string; input: ReserveInput };
const db = openDatabaseFile(data.databaseFile);
try {
  const result = reserveSignup(db, data.input);
  process.stdout.write(JSON.stringify({
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    replay: result.ok ? result.replay : false,
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({
    ok: false,
    reason: 'error',
    replay: false,
    message: err instanceof Error ? err.message : String(err),
  }));
  process.exitCode = 1;
} finally {
  db.close();
}
