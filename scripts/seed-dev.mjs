import { runSeedCli } from '../src/dev/seed.ts';

runSeedCli().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
