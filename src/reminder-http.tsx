import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { readSession } from './auth/session.js';
import { clientAddress } from './client-ip.js';
import type { AppConfig } from './config.js';
import { Layout, NotFoundPage, ReminderOffPage, WaitPage } from './pages.js';
import { recordInvalidUnsubscribe } from './rate-limit.js';
import { disableReminders, readReminderOffToken } from './reminders.js';
import { readReplyTo } from './settings.js';
import { isBusy } from './sqlite-error.js';
import { appPath } from './url.js';
import type Database from 'better-sqlite3';

export function registerReminderOff(
  app: Hono,
  services: {
    config: AppConfig;
    db: Database.Database;
    now: () => string;
    clientIp?: (c: Context) => string | null;
  },
): void {
  app.get(appPath(services.config, '/u/:token'), (c) => showReminderOff(c, services));
  app.post(appPath(services.config, '/u/:token'), (c) => submitReminderOff(c, services));
}

function showReminderOff(
  c: Context,
  services: { config: AppConfig; db: Database.Database; now: () => string; clientIp?: (c: Context) => string | null },
) {
  const signupId = readReminderOffToken(services.config.sessionSecret, c.req.param('token') ?? '');
  if (signupId === null || !reminderSignup(services.db, signupId)) return unavailable(c, services);
  const off = remindersOff(services.db, signupId);
  return page(c, services, <ReminderOffPage config={services.config} token={c.req.param('token') ?? ''} replyTo={readReplyTo(services.db, services.config.mail.replyTo)} off={off} />);
}

async function submitReminderOff(
  c: Context,
  services: { config: AppConfig; db: Database.Database; now: () => string; clientIp?: (c: Context) => string | null },
): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const signupId = readReminderOffToken(services.config.sessionSecret, token);
  if (signupId === null || !reminderSignup(services.db, signupId)) return unavailable(c, services);
  try {
    const result = disableReminders(services.db, signupId, services.now());
    if (!result.ok) return unavailable(c, services);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Reminder opt-out could not lock the database.');
    return page(c, services, <ReminderOffPage config={services.config} token={token} replyTo={readReplyTo(services.db, services.config.mail.replyTo)} off={false} error="This could not be saved. Please try again." />, 503);
  }
  return page(c, services, <ReminderOffPage config={services.config} token={token} replyTo={readReplyTo(services.db, services.config.mail.replyTo)} off />);
}

function reminderSignup(db: Database.Database, signupId: number): boolean {
  const row = db.prepare('SELECT id FROM signups WHERE id = ? AND anonymized_at IS NULL').get(signupId);
  return Boolean(row);
}

function remindersOff(db: Database.Database, signupId: number): boolean {
  const row = db.prepare('SELECT reminders_off AS reminders_off FROM signups WHERE id = ?').get(signupId) as { reminders_off: number } | undefined;
  return row?.reminders_off === 1;
}

function unavailable(
  c: Context,
  services: { config: AppConfig; db: Database.Database; now: () => string; clientIp?: (c: Context) => string | null },
) {
  const ip = clientAddress(services.config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  const limit = recordInvalidUnsubscribe(services.db, services.config.sessionSecret, services.now(), ip);
  if (limit.limited) {
    c.header('Retry-After', String(limit.retryAfter));
    return page(c, services, <WaitPage />, 429);
  }
  return page(c, services, <NotFoundPage />, 404);
}

function peerAddress(c: Context, override?: (c: Context) => string | null): string | null {
  if (override) return override(c);
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

function page(
  c: Context,
  services: { config: AppConfig; db: Database.Database; now: () => string },
  body: Child,
  status: 200 | 404 | 429 | 503 = 200,
) {
  c.header('Cache-Control', 'no-store');
  const account = readSession(services.db, c.req.header('cookie'), services.now());
  return c.html(
    <Layout config={services.config} title="Reminder emails · Hope Volunteer" path={c.req.path} account={account ? { csrf: account.csrf } : null}>
      {body}
    </Layout>,
    status,
  );
}
