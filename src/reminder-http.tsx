import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type Database from 'better-sqlite3';
import { readSession } from './auth/session.js';
import { issueReminderCancelToken, reminderCancelTokenMatches } from './cancel-token.js';
import { clientAddress } from './client-ip.js';
import type { AppConfig } from './config.js';
import type { MailIdentity } from './mail/types.js';
import { originAllowed } from './origin.js';
import { Layout, NotFoundPage, ReminderCancelPage, ReminderOffPage, WaitPage } from './pages.js';
import { recordInvalidUnsubscribe } from './rate-limit.js';
import { disableReminders, readReminderOffToken, readReminderSignup, type ReminderPageSignup } from './reminders.js';
import { readReplyTo } from './settings.js';
import { cancelSignupById } from './signup.js';
import { isBusy } from './sqlite-error.js';
import { absoluteUrl, appPath } from './url.js';

const CANCEL_ORIGIN = 'The cancellation could not be sent from this page.';
const CANCEL_REJECTED = 'The cancellation could not be confirmed. Please try again.';
const CANCEL_UNAVAILABLE = 'The cancellation could not be saved. Please try again in a little while.';

type ReminderServices = {
  config: AppConfig;
  db: Database.Database;
  now: () => string;
  clientIp?: (c: Context) => string | null;
};

/**
 * The reminder link opens one signup.
 * POST /u/:token only turns reminders off, because mail clients one-click unsubscribe to that address.
 * Cancelling is a separate confirmed POST.
 */
export function registerReminderOff(app: Hono, services: ReminderServices): void {
  const unsubscribe = appPath(services.config, '/u/:token');
  const cancel = appPath(services.config, '/u/:token/cancel');
  app.get(cancel, (c) => showCancel(c, services));
  app.post(cancel, (c) => submitCancel(c, services));
  app.get(unsubscribe, (c) => showReminderOff(c, services));
  app.post(unsubscribe, (c) => submitReminderOff(c, services));
}

function showReminderOff(c: Context, services: ReminderServices) {
  const loaded = loadSignup(c, services);
  if (!loaded) return unavailable(c, services);
  return page(c, services, 'Your signup · Hope Volunteer', <ReminderOffPage config={services.config} token={loaded.token} signup={loaded.signup} />);
}

async function submitReminderOff(c: Context, services: ReminderServices): Promise<Response> {
  const loaded = loadSignup(c, services);
  if (!loaded) return unavailable(c, services);
  try {
    const result = disableReminders(services.db, loaded.signupId, services.now());
    if (!result.ok) return unavailable(c, services);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Reminder opt-out could not lock the database.');
    return page(
      c,
      services,
      'Your signup · Hope Volunteer',
      <ReminderOffPage config={services.config} token={loaded.token} signup={loaded.signup} error="This could not be saved. Please try again." />,
      503,
    );
  }
  const signup = readReminderSignup(services.db, loaded.signupId, services.now()) ?? { ...loaded.signup, remindersOff: true };
  return page(c, services, 'Your signup · Hope Volunteer', <ReminderOffPage config={services.config} token={loaded.token} signup={signup} />);
}

function showCancel(c: Context, services: ReminderServices) {
  const loaded = loadSignup(c, services);
  if (!loaded) return unavailable(c, services);
  if (!canCancel(loaded.signup)) {
    c.header('Cache-Control', 'no-store');
    return c.redirect(appPath(services.config, `/u/${loaded.token}`), 303);
  }
  return confirmPage(c, services, loaded.token, loaded.signup);
}

async function submitCancel(c: Context, services: ReminderServices): Promise<Response> {
  const loaded = loadSignup(c, services);
  if (!loaded) return unavailable(c, services);
  if (loaded.signup.status === 'cancelled') {
    c.header('Cache-Control', 'no-store');
    return c.redirect(appPath(services.config, `/u/${loaded.token}`), 303);
  }
  if (!canCancel(loaded.signup)) {
    return page(c, services, 'Your signup · Hope Volunteer', <ReminderOffPage config={services.config} token={loaded.token} signup={loaded.signup} />, 400);
  }
  if (!originAllowed(c, services.config.baseUrl)) return confirmPage(c, services, loaded.token, loaded.signup, 403, CANCEL_ORIGIN);
  const body = await c.req.parseBody();
  if (!reminderCancelTokenMatches(services.config.sessionSecret, loaded.token, textField(body, 'cancel_token'))) {
    return confirmPage(c, services, loaded.token, loaded.signup, 400, CANCEL_REJECTED);
  }
  try {
    const result = cancelSignupById(
      services.db,
      loaded.signupId,
      services.now(),
      mailIdentity(services),
      absoluteUrl(services.config, `/u/${loaded.token}`),
    );
    if (!result.ok && result.reason === 'ended') {
      const signup = readReminderSignup(services.db, loaded.signupId, services.now()) ?? loaded.signup;
      return page(c, services, 'Your signup · Hope Volunteer', <ReminderOffPage config={services.config} token={loaded.token} signup={signup} />, 400);
    }
    if (!result.ok) return unavailable(c, services);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Cancellation could not lock the database.');
    return confirmPage(c, services, loaded.token, loaded.signup, 503, CANCEL_UNAVAILABLE);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/u/${loaded.token}`), 303);
}

function loadSignup(c: Context, services: ReminderServices): { token: string; signupId: number; signup: ReminderPageSignup } | null {
  const token = c.req.param('token') ?? '';
  const signupId = readReminderOffToken(services.config.sessionSecret, token);
  if (signupId === null) return null;
  const signup = readReminderSignup(services.db, signupId, services.now());
  if (!signup) return null;
  return { token, signupId, signup };
}

function canCancel(signup: ReminderPageSignup): boolean {
  return signup.status === 'confirmed' && !signup.ended;
}

function confirmPage(
  c: Context,
  services: ReminderServices,
  token: string,
  signup: ReminderPageSignup,
  status: 200 | 400 | 403 | 503 = 200,
  error?: string,
) {
  return page(
    c,
    services,
    'Cancel this signup · Hope Volunteer',
    <ReminderCancelPage
      config={services.config}
      token={token}
      signup={signup}
      cancelToken={issueReminderCancelToken(services.config.sessionSecret, token)}
      error={error}
    />,
    status,
  );
}

function unavailable(c: Context, services: ReminderServices) {
  const ip = clientAddress(services.config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  const limit = recordInvalidUnsubscribe(services.db, services.config.sessionSecret, services.now(), ip);
  if (limit.limited) {
    c.header('Retry-After', String(limit.retryAfter));
    return page(c, services, 'Please wait · Hope Volunteer', <WaitPage />, 429);
  }
  return page(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
}

function peerAddress(c: Context, override?: (c: Context) => string | null): string | null {
  if (override) return override(c);
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

function page(c: Context, services: ReminderServices, title: string, body: Child, status: 200 | 400 | 403 | 404 | 429 | 503 = 200) {
  c.header('Cache-Control', 'no-store');
  const account = readSession(services.db, c.req.header('cookie'), services.now());
  return c.html(
    <Layout config={services.config} title={title} path={c.req.path} account={account ? { csrf: account.csrf } : null}>
      {body}
    </Layout>,
    status,
  );
}

function mailIdentity(services: ReminderServices): MailIdentity {
  return {
    baseUrl: services.config.baseUrl,
    basePath: services.config.basePath,
    from: services.config.mail.from,
    replyTo: replyTo(services),
  };
}

function replyTo(services: ReminderServices): string {
  return readReplyTo(services.db, services.config.mail.replyTo);
}

function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}
