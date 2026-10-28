import { Temporal } from '@js-temporal/polyfill';
import { getConnInfo } from '@hono/node-server/conninfo';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { listMoveTargets, switchSignup } from './admin/store.js';
import { readSession } from './auth/session.js';
import { cancelTokenMatches, issueCancelToken, issueReminderPageToken, issueSwitchToken, reminderPageTokenMatches, switchTokenMatches } from './cancel-token.js';
import { clientAddress } from './client-ip.js';
import { confirmationCookie, openConfirmation, sealConfirmation } from './confirm-cookie.js';
import type { AppConfig } from './config.js';
import { issueFormToken, newOperationId, openFormToken, readFormToken } from './form-token.js';
import { originAllowed } from './origin.js';
import { readReplyTo } from './settings.js';
import {
  ConfirmationPage,
  Layout,
  ManagePage,
  NotFoundPage,
  ShiftPage,
  SwitchAlreadyPage,
  WaitPage,
  type SignupFormView,
  type SwitchForm,
} from './pages.js';
import { recordInvalidManageToken, recordSignupEmail, recordSignupIp, recordSwitchAttempt } from './rate-limit.js';
import { getPublicShift, type PublicShift } from './schedule.js';
import { SIGNUP_TOO_EARLY } from './signup-window.js';
import { EMPTY_SIGNUP, parseSignupForm, spotsLeftMessage, type SignupErrors, type SignupValues } from './signup-form.js';
import type { MailIdentity } from './mail/types.js';
import { disableReminders } from './reminders.js';
import { cancelSignup, confirmedOperationShift, findSignupByOperation, readManageSignup, reserveSignup } from './signup.js';
import { verifyTurnstile, type TurnstileCheck, type TurnstileVerdict } from './turnstile.js';
import { appPath, cookiePath } from './url.js';

const COULD_NOT_SAVE =
  'This signup could not be saved. If this shift is already in your confirmation, use that link.';
const ALREADY_SIGNED_UP =
  'That person is already signed up for this shift. Use the link in the confirmation email.';
const TOO_FAST = 'Please wait a few seconds and submit the form again.';
const CHECK_AGAIN = 'The check did not finish. Please try again.';
const CHECK_UNAVAILABLE = 'The check could not be reached. Please try again in a little while.';
const TOO_MANY = 'Too many signup attempts. Please wait and try again.';
const FULL = 'This shift is full.';
const CLOSED = 'This shift is closed.';
const ORIGIN = 'The signup could not be sent from this page.';
const CANCEL_ORIGIN = 'The cancellation could not be sent from this page.';
const CANCEL_REJECTED = 'The cancellation could not be confirmed. Please try again.';
const CANCEL_UNAVAILABLE = 'The cancellation could not be saved. Please try again in a little while.';
const SWITCH_ORIGIN = 'The switch could not be sent from this page.';
const SWITCH_REJECTED = 'The switch could not be confirmed. Please try again.';
const SWITCH_UNAVAILABLE = 'The switch could not be saved. Please try again in a little while.';
const SWITCH_STALE = 'This form is out of date. Submit it again.';
const SWITCHED_NOTE = 'You are on this shift. This link replaces the earlier one. A change email is queued.';
const EXPIRED = 'This form expired. Please submit it again.';

export type SignupServices = {
  config: AppConfig;
  db: Database.Database;
  now: () => string;
  clientIp?: (c: Context) => string | null;
  verifyTurnstile?: (input: TurnstileCheck) => Promise<TurnstileVerdict>;
};

export function registerPublicSignup(app: Hono, services: SignupServices): void {
  const { config } = services;

  app.get(appPath(config, '/s/:id'), (c) => {
    const shift = loadShift(services, c.req.param('id') ?? '');
    if (!shift) return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
    return shiftResponse(c, services, shift, 200, blankForm(services, shift));
  });

  app.post(appPath(config, '/s/:id'), (c) => submitSignup(c, services));

  app.get(appPath(config, '/s/:id/confirmed'), (c) => {
    const shift = loadShift(services, c.req.param('id') ?? '');
    if (!shift) return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
    const seal = openConfirmation(config.sessionSecret, c.req.header('cookie'), epochMs(services.now()));
    const manage = seal && seal.shiftId === shift.id ? readManageSignup(services.db, seal.token, services.now()) : null;
    const matches = Boolean(manage && seal && manage.signupId === seal.signupId);
    const cancelled = matches && manage?.status === 'cancelled';
    return html(
      c,
      services,
      cancelled ? 'This signup is cancelled · Hope Volunteer' : "You're signed up · Hope Volunteer",
      <ConfirmationPage
        config={config}
        shift={shift}
        name={matches && manage ? manage.name : null}
        managePath={matches && seal ? appPath(config, `/m/${seal.token}`) : null}
        groupSize={matches && manage ? manage.groupSize : undefined}
        cancelled={cancelled}
      />,
    );
  });

  app.get(appPath(config, '/m/:token'), (c) => showManage(c, services, c.req.param('token') ?? ''));

  app.post(appPath(config, '/m/:token/switch'), (c) => submitSwitch(c, services));
  app.post(appPath(config, '/m/:token/reminders'), (c) => submitRemindersOff(c, services));
  app.post(appPath(config, '/m/:token'), (c) => submitCancel(c, services));
}

async function submitSignup(c: Context, services: SignupServices): Promise<Response> {
  const { config, db } = services;
  const now = services.now();
  const shift = loadShift(services, c.req.param('id') ?? '');
  if (!shift) return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
  if (shift.tooEarly) return shiftResponse(c, services, shift, 400, null, SIGNUP_TOO_EARLY);
  const ip = clientAddress(config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  if (!originAllowed(c, config.baseUrl)) {
    return shiftResponse(c, services, shift, 403, formFor(services, shift, EMPTY_SIGNUP, {}, null), ORIGIN);
  }
  const ipLimit = recordSignupIp(db, config.sessionSecret, now, ip);
  if (ipLimit.limited) {
    return shiftResponse(c, services, shift, 429, blankForm(services, shift), TOO_MANY, ipLimit.retryAfter);
  }
  const body = await c.req.parseBody();
  const values = valuesFrom(body);
  if (textField(body, 'company_website').trim() !== '') {
    return shiftResponse(c, services, shift, 409, formFor(services, shift, values, {}, null), COULD_NOT_SAVE);
  }
  const tokenResult = readFormToken(config.sessionSecret, textField(body, 'form_token'), shift.id, epochMs(now));
  if (!tokenResult.ok) {
    const notice = tokenResult.reason === 'too_fast' ? TOO_FAST : EXPIRED;
    const token = tokenResult.reason === 'too_fast' ? textField(body, 'form_token') : null;
    return shiftResponse(c, services, shift, 400, formFor(services, shift, values, {}, token), notice);
  }
  const parsed = parseSignupForm(values);
  if (!parsed.ok) {
    return shiftResponse(c, services, shift, 400, formFor(services, shift, values, parsed.errors, textField(body, 'form_token')), undefined);
  }
  const existing = findSignupByOperation(db, tokenResult.claims.operationId);
  if (existing && existing.shiftId === shift.id && existing.emailNorm === parsed.draft.emailNorm) {
    return redirectConfirmed(c, services, shift.id, null);
  }
  if (existing) {
    return shiftResponse(c, services, shift, 409, formFor(services, shift, values, {}, null), COULD_NOT_SAVE);
  }
  const turnstileToken = textField(body, 'cf-turnstile-response').trim();
  const verdict = turnstileToken === ''
    ? ({ ok: false, reason: 'rejected' } as const)
    : await checkTurnstile(services, turnstileToken, ip);
  if (!verdict.ok) {
    if (verdict.reason === 'duplicate') {
      const again = findSignupByOperation(db, tokenResult.claims.operationId);
      if (again && again.shiftId === shift.id && again.emailNorm === parsed.draft.emailNorm) {
        return redirectConfirmed(c, services, shift.id, null);
      }
    }
    const notice = verdict.reason === 'unavailable' ? CHECK_UNAVAILABLE : CHECK_AGAIN;
    return shiftResponse(c, services, shift, verdict.reason === 'unavailable' ? 503 : 400, formFor(services, shift, values, {}, textField(body, 'form_token')), notice);
  }
  const emailLimit = recordSignupEmail(db, config.sessionSecret, now, config.defaultTimeZone, parsed.draft.emailNorm);
  if (emailLimit.limited) {
    return shiftResponse(c, services, shift, 429, formFor(services, shift, values, {}, textField(body, 'form_token')), TOO_MANY, emailLimit.retryAfter);
  }
  try {
    const reserved = reserveSignup(db, {
      shiftId: shift.id,
      name: parsed.draft.name,
      email: parsed.draft.emailNorm,
      phone: parsed.draft.phone,
      notes: parsed.draft.notes,
      groupSize: parsed.draft.groupSize,
      operationId: tokenResult.claims.operationId,
      now,
      mail: mailIdentity(db, config),
    });
    if (reserved.ok) return redirectConfirmed(c, services, shift.id, reserved.manageToken ? { signupId: reserved.signupId, token: reserved.manageToken } : null);
    if (reserved.reason === 'not_found') return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
    if (reserved.reason === 'closed') return shiftResponse(c, services, loadShift(services, String(shift.id)) ?? shift, 400, null, CLOSED);
    if (reserved.reason === 'early') return shiftResponse(c, services, loadShift(services, String(shift.id)) ?? shift, 400, null, SIGNUP_TOO_EARLY);
    if (reserved.reason === 'full') {
      const current = loadShift(services, String(shift.id)) ?? shift;
      if (current.remaining > 0) {
        return shiftResponse(
          c,
          services,
          current,
          409,
          formFor(services, shift, values, { partySize: spotsLeftMessage(current.remaining) }, textField(body, 'form_token')),
        );
      }
      return shiftResponse(c, services, current, 409, null, FULL);
    }
    if (reserved.reason === 'duplicate') {
      return shiftResponse(c, services, shift, 409, formFor(services, shift, values, {}, null), ALREADY_SIGNED_UP);
    }
    return shiftResponse(c, services, shift, 409, formFor(services, shift, values, {}, null), COULD_NOT_SAVE);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Signup could not lock the database.');
    return shiftResponse(c, services, shift, 503, formFor(services, shift, values, {}, textField(body, 'form_token')), CHECK_UNAVAILABLE);
  }
}

function redirectConfirmed(
  c: Context,
  services: SignupServices,
  shiftId: number,
  issued: { signupId: number; token: string } | null,
): Response {
  if (issued) {
    const sealed = sealConfirmation(services.config.sessionSecret, {
      signupId: issued.signupId,
      shiftId,
      token: issued.token,
      expiresAtMs: epochMs(services.now()) + 900 * 1000,
    });
    c.header('Set-Cookie', confirmationCookie(sealed, cookiePath(services.config), services.config.secureCookies));
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/s/${shiftId}/confirmed`), 303);
}

function shiftResponse(
  c: Context,
  services: SignupServices,
  shift: PublicShift,
  status: 200 | 400 | 403 | 409 | 429 | 503,
  signup: SignupFormView | null,
  notice?: string,
  retryAfter?: number,
) {
  if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  const current = loadShift(services, String(shift.id)) ?? shift;
  const showForm = signup !== null && !current.cancelled && !current.ended && !current.full && !current.tooEarly;
  return html(
    c,
    services,
    `${current.role} · Hope Volunteer`,
    <ShiftPage config={services.config} shift={current} signup={showForm ? signup : null} notice={notice} />,
    status,
    showForm,
  );
}

function blankForm(services: SignupServices, shift: PublicShift): SignupFormView | null {
  if (shift.cancelled || shift.ended || shift.full || shift.tooEarly) return null;
  return formFor(services, shift, EMPTY_SIGNUP, {}, null);
}

function formFor(
  services: SignupServices,
  shift: PublicShift,
  values: SignupValues,
  errors: SignupErrors,
  token: string | null,
): SignupFormView {
  return {
    token: token && token.length > 0 ? token : issueFormToken(services.config.sessionSecret, {
      shiftId: shift.id,
      issuedAt: epochMs(services.now()),
      operationId: newOperationId(),
    }),
    siteKey: services.config.turnstile.siteKey,
    values,
    errors,
  };
}

async function checkTurnstile(services: SignupServices, token: string, remoteIp: string): Promise<TurnstileVerdict> {
  const verify = services.verifyTurnstile ?? verifyTurnstile;
  try {
    return await verify({
      secret: services.config.turnstile.secretKey,
      token,
      remoteIp,
      expectedHostname: new URL(services.config.baseUrl).hostname,
      expectedAction: 'signup',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function loadShift(services: SignupServices, rawId: string): PublicShift | null {
  const id = parseShiftId(rawId);
  if (id === null) return null;
  return getPublicShift(services.db, id, services.now());
}

function valuesFrom(body: Record<string, unknown>): SignupValues {
  return {
    name: '',
    firstName: textField(body, 'first_name'),
    lastName: textField(body, 'last_name'),
    email: textField(body, 'email'),
    phone: textField(body, 'phone'),
    notes: textField(body, 'notes'),
    partySize: textField(body, 'party_size'),
  };
}

function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function peerAddress(c: Context, override: SignupServices['clientIp']): string | null {
  if (override) return override(c);
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

function showManage(c: Context, services: SignupServices, token: string, status: 200 | 400 | 403 | 429 | 503 = 200, notice?: string) {
  const signup = readManageSignup(services.db, token, services.now());
  if (!signup) return missingManage(c, services);
  const note = manageNote(c.req.query('notice'));
  return html(
    c,
    services,
    'Your signup · Hope Volunteer',
    <ManagePage
      signup={signup}
      cancel={cancelForm(services, token, signup.status)}
      switches={switchForm(services, token, signup)}
      reminders={reminderForm(services, token, signup)}
      notice={notice}
      note={note}
    />,
    status,
  );
}

function manageNote(notice: string | undefined): string | undefined {
  if (notice === 'switched') return SWITCHED_NOTE;
  return undefined;
}

function missingManage(c: Context, services: SignupServices) {
  const ip = clientAddress(services.config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  const limit = recordInvalidManageToken(services.db, services.config.sessionSecret, services.now(), ip);
  if (limit.limited) {
    c.header('Retry-After', String(limit.retryAfter));
    return html(c, services, 'Please wait · Hope Volunteer', <WaitPage />, 429);
  }
  return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
}

async function submitCancel(c: Context, services: SignupServices): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const signup = readManageSignup(services.db, token, services.now());
  if (!signup) return missingManage(c, services);
  if (!originAllowed(c, services.config.baseUrl)) {
    return showManage(c, services, token, 403, CANCEL_ORIGIN);
  }
  const body = await c.req.parseBody();
  if (!cancelTokenMatches(services.config.sessionSecret, token, textField(body, 'cancel_token'))) {
    return showManage(c, services, token, 400, CANCEL_REJECTED);
  }
  try {
    const result = cancelSignup(services.db, token, services.now(), mailIdentity(services.db, services.config));
    if (!result.ok) return missingManage(c, services);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Cancellation could not lock the database.');
    return showManage(c, services, token, 503, CANCEL_UNAVAILABLE);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/m/${token}`), 303);
}

async function submitSwitch(c: Context, services: SignupServices): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const signup = readManageSignup(services.db, token, services.now());
  if (!originAllowed(c, services.config.baseUrl)) {
    if (!signup) return html(c, services, 'Your signup · Hope Volunteer', <SwitchAlreadyPage />, 403);
    return showManage(c, services, token, 403, SWITCH_ORIGIN);
  }
  const body = await c.req.parseBody();
  if (!signup) return switchedAlready(c, services, token, body);
  if (!switchTokenMatches(services.config.sessionSecret, token, textField(body, 'switch_token'))) {
    return showManage(c, services, token, 400, SWITCH_REJECTED);
  }
  if (signup.status !== 'confirmed') return showManage(c, services, token, 400, 'This signup is cancelled.');
  const destination = Number(textField(body, 'destination'));
  if (!Number.isSafeInteger(destination) || destination <= 0) return showManage(c, services, token, 400, 'Choose a shift.');
  const formToken = readFormToken(services.config.sessionSecret, textField(body, 'form_token'), signup.shiftId, epochMs(services.now()), 0);
  if (!formToken.ok) return showManage(c, services, token, 400, SWITCH_STALE);
  try {
    const ip = clientAddress(services.config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
    const limit = recordSwitchAttempt(
      services.db, services.config.sessionSecret, services.now(), services.config.defaultTimeZone, ip, [signup.emailNorm],
    );
    if (limit.limited) {
      c.header('Retry-After', String(limit.retryAfter));
      return showManage(c, services, token, 429, 'Too many switch attempts. Please try again later. You are still signed up for this shift.');
    }
    const result = switchSignup(services.db, signup.signupId, destination, formToken.claims.operationId, services.now(), mailIdentity(services.db, services.config));
    if (!result.ok) return showManage(c, services, token, 400, result.error);
    if (!result.manageToken) return html(c, services, 'Your signup · Hope Volunteer', <SwitchAlreadyPage />);
    c.header('Cache-Control', 'no-store');
    return c.redirect(appPath(services.config, `/m/${result.manageToken}?notice=switched`), 303);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Switch could not lock the database.');
    return showManage(c, services, token, 503, SWITCH_UNAVAILABLE);
  }
}

function switchedAlready(c: Context, services: SignupServices, token: string, body: Record<string, unknown>) {
  if (!switchTokenMatches(services.config.sessionSecret, token, textField(body, 'switch_token'))) return missingManage(c, services);
  const formToken = openFormToken(services.config.sessionSecret, textField(body, 'form_token'), epochMs(services.now()), 0);
  if (!formToken.ok) return missingManage(c, services);
  const shiftId = confirmedOperationShift(services.db, formToken.claims.operationId);
  if (shiftId === null) return missingManage(c, services);
  return html(c, services, 'Your signup · Hope Volunteer', <SwitchAlreadyPage />);
}

function switchForm(services: SignupServices, token: string, signup: { status: 'confirmed' | 'cancelled'; shiftId: number; eventId: number; name: string; email: string; groupSize: number }): SwitchForm | null {
  if (signup.status !== 'confirmed') return null;
  const targets = listMoveTargets(services.db, signup.eventId, signup.shiftId, services.now(), {
    publishedOnly: true,
    signupWindow: true,
    spotsNeeded: signup.groupSize,
  });
  if (targets.length === 0) return { action: '', token: '', formToken: '', targets };
  return {
    action: appPath(services.config, `/m/${token}/switch`),
    token: issueSwitchToken(services.config.sessionSecret, token),
    formToken: issueFormToken(services.config.sessionSecret, {
      shiftId: signup.shiftId,
      issuedAt: epochMs(services.now()),
      operationId: newOperationId(),
    }),
    targets,
  };
}

function reminderForm(
  services: SignupServices,
  token: string,
  signup: { status: 'confirmed' | 'cancelled'; remindersOff: boolean },
): { action: string; token: string } | 'off' | null {
  if (signup.status !== 'confirmed') return null;
  if (signup.remindersOff) return 'off';
  return {
    action: appPath(services.config, `/m/${token}/reminders`),
    token: issueReminderPageToken(services.config.sessionSecret, token),
  };
}

async function submitRemindersOff(c: Context, services: SignupServices): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const signup = readManageSignup(services.db, token, services.now());
  if (!signup) return missingManage(c, services);
  if (!originAllowed(c, services.config.baseUrl)) {
    return showManage(c, services, token, 403, CANCEL_ORIGIN);
  }
  const body = await c.req.parseBody();
  if (!reminderPageTokenMatches(services.config.sessionSecret, token, textField(body, 'reminder_token'))) {
    return showManage(c, services, token, 400, CANCEL_REJECTED);
  }
  try {
    const result = disableReminders(services.db, signup.signupId, services.now());
    if (!result.ok) return missingManage(c, services);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Reminder opt-out could not lock the database.');
    return showManage(c, services, token, 503, CANCEL_UNAVAILABLE);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/m/${token}`), 303);
}

function cancelForm(services: SignupServices, token: string, status: 'confirmed' | 'cancelled'): { action: string; token: string } | null {
  if (status !== 'confirmed') return null;
  return {
    action: appPath(services.config, `/m/${token}`),
    token: issueCancelToken(services.config.sessionSecret, token),
  };
}

function html(
  c: Context,
  services: SignupServices,
  title: string,
  body: Child,
  status: 200 | 400 | 403 | 404 | 409 | 429 | 503 = 200,
  turnstile = false,
) {
  c.header('Cache-Control', 'no-store');
  const account = readSession(services.db, c.req.header('cookie'), services.now());
  return c.html(
    <Layout config={services.config} title={title} path={c.req.path} turnstile={turnstile} account={account ? { csrf: account.csrf } : null}>
      {body}
    </Layout>,
    status,
  );
}

function mailIdentity(db: Database.Database, config: AppConfig): MailIdentity {
  return {
    baseUrl: config.baseUrl,
    basePath: config.basePath,
    from: config.mail.from,
    replyTo: readReplyTo(db, config.mail.replyTo),
  };
}

function epochMs(utc: string): number {
  return Temporal.Instant.from(utc).epochMilliseconds;
}

function parseShiftId(value: string): number | null {
  return parsePositiveId(value);
}

function parsePositiveId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function isBusy(err: unknown): boolean {
  return err instanceof Error && 'code' in err && String((err as { code: unknown }).code).includes('SQLITE_BUSY');
}
