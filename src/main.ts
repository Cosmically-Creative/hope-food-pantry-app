import { chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { MigrationError, openAppDatabase } from './db.js';
import { createMailer } from './mail/driver.js';
import { startOutboxRunner } from './mail/run.js';
import { startDailyExpansionRunner } from './jobs/daily-expand.js';
import { backupDirectory, startBackupRunner } from './jobs/backup.js';
import { runRetention, startHourlyCleanupRunner, startRetentionRunner } from './jobs/retention.js';
import { expandTemplates } from './recurrence.js';
import { startReminderRunner } from './reminders-run.js';
import { nowUtc } from './time.js';

// The database, its WAL files, and backups hold volunteer contact details. Owner only.
process.umask(0o077);

async function main(): Promise<void> {
  let database: Awaited<ReturnType<typeof openAppDatabase>> | undefined;
  try {
    const config = loadConfig(process.env);
    if (config.nodeEnv === 'production' && config.trustProxy.mode === 'disabled' && config.bindHost === '0.0.0.0') {
      console.warn(
        'TRUST_PROXY is false. Behind Caddy every visitor shares one address and one set of rate limits. Set TRUST_PROXY to the proxy peer.',
      );
    }
    database = await openAppDatabase(config);
    restrictDataFiles(config.databaseFile, backupDirectory(config.dataDir));
    const startedAt = nowUtc();
    const created = bootstrapAdmin(database, config.bootstrapAdminEmail, startedAt);
    if (created.created) {
      console.log('Created the first administrator. Sign in with the address in BOOTSTRAP_ADMIN_EMAIL.');
    }
    const expanded = expandTemplates(database, startedAt);
    if (expanded.created > 0) {
      console.log(`Added ${expanded.created} weekly shifts for the next three months.`);
    }
    for (const skip of expanded.skipped) console.error(skip);
    runRetention(database, startedAt);
    const app = createApp(config, database);
    const mail = startOutboxRunner(database, createMailer(config), nowUtc);
    const reminders = startReminderRunner(
      database,
      { baseUrl: config.baseUrl, basePath: config.basePath, from: config.mail.from, replyTo: config.mail.replyTo },
      config.sessionSecret,
      nowUtc,
    );
    const refill = startDailyExpansionRunner(database, nowUtc);
    const retention = startRetentionRunner(database, nowUtc);
    const hourly = startHourlyCleanupRunner(database, nowUtc);
    const backup = startBackupRunner(database, backupDirectory(config.dataDir), nowUtc);
    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.bindHost,
    });
    console.log(`Hope Volunteer is at ${config.baseUrl}${config.basePath || '/'} (bound to ${config.bindHost}:${config.port}).`);
    waitForShutdown(server, database, () => {
      mail.stop();
      reminders.stop();
      refill.stop();
      retention.stop();
      hourly.stop();
      backup.stop();
    });
  } catch (err) {
    database?.close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    if (!(err instanceof ConfigError || err instanceof MigrationError) || !message.includes('Startup aborted.')) {
      console.error('Startup aborted.');
    }
    process.exitCode = 1;
  }
}

/** Files created before the umask above may still be readable by others. */
function restrictDataFiles(databaseFile: string, backups: string): void {
  const files = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`];
  try {
    for (const entry of readdirSync(backups, { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(backups, entry.name));
    }
  } catch {
    // No backups yet.
  }
  for (const file of files) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Missing, or owned by someone else. The host owner fixes that.
    }
  }
}

function waitForShutdown(server: ServerType, database: { close: () => void }, stopMail: () => void): void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopMail();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      database.close();
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 1000).unref();
  };
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.message);
    console.error('Startup aborted.');
    database.close();
    process.exit(1);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
