import { Temporal } from '@js-temporal/polyfill';
import { getConnInfo } from '@hono/node-server/conninfo';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { listMoveTargets, switchSignup } from './admin/store.js';
import { readSession } from './auth/session.js';
import { cancelTokenMatches, issueCancelToken, issuePartyToken, issueReminderPageToken, issueSwitchToken, partyTokenMatches, reminderPageTokenMatches, switchTokenMatches } from './cancel-token.js';
import { clientAddress } from './client-ip.js';
import { confirmationCookie, openConfirmation, sealConfirmation, type ConfirmationCompanion } from './confirm-cookie.js';
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
  type PartyForm,
  type SignupFormView,
  type SwitchForm,
} from './pages.js';
import { recordInvalidManageToken, recordSignupEmail, recordSignupIp, recordSwitchAttempt } from './rate-limit.js';
import { getPublicShift, listSignupDates, listSignupSlot, type PublicShift, type SignupDateChoice } from './schedule.js';
import { SIGNUP_TOO_EARLY } from './signup-window.js';
import { EMPTY_SIGNUP, MAX_SIGNUP_DATES, parsePartySize, parseSignupForm, spotsLeftMessage, type SignupErrors, type SignupValues } from './signup-form.js';
import type { MailIdentity } from './mail/types.js';
import { disableReminders, enableReminders, queueDueReminders } from './reminders.js';
import { cancelSignup, changePartySize, confirmedOperationShift, findSignupByOperation, groupedOperationSignups, managePartyLimit, readManageSignup, reserveSignup, reserveSignups } from './signup.js';
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
const SWITCHED_NOTE = 'You are on this shift. This link replaces the earlier one. A change email is on the way.';
const PARTY_ORIGIN = 'The update could not be sent from this page.';
const PARTY_REJECTED = 'The update could not be confirmed. Please try again.';
const PARTY_UNAVAILABLE = 'The update could not be saved. Please try again in a little while.';
const PARTY_NOTE = 'The number of people on this signup is saved. The signup stays.';
const SHIFT_ENDED = 'This shift has ended.';
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
    const also = matches && seal && !cancelled ? confirmedCompanions(services, seal) : [];
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
        also={also}
      />,
    );
  });

  app.get(appPath(config, '/m/:token'), (c) => showManage(c, services, c.req.param('token') ?? ''));

  app.post(appPath(config, '/m/:token/switch'), (c) => submitSwitch(c, services));
  app.post(appPath(config, '/m/:token/party'), (c) => submitParty(c, services));
  app.post(appPath(config, '/m/:token/reminders'), (c) => submitReminders(c, services));
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
  const body = await c.req.parseBody({ all: true });
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
  const selection = readDateSelection(body, shift.id, listSignupSlot(db, shift, now));
  const parsed = parseSignupForm(values);
  if (!parsed.ok || !selection.ok) {
    const errors: SignupErrors = parsed.ok ? {} : parsed.errors;
    if (!selection.ok) errors.dates = selection.error;
    return shiftResponse(
      c,
      services,
      shift,
      400,
      formFor(services, shift, values, errors, textField(body, 'form_token'), selection.shiftIds),
    );
  }
  const several = selection.shiftIds.length > 1 || selection.shiftIds[0] !== shift.id;
  const existing = findSignupByOperation(db, tokenResult.claims.operationId);
  if (!several && existing && existing.shiftId === shift.id && existing.emailNorm === parsed.draft.emailNorm) {
    return redirectConfirmed(c, services, shift.id, null);
  }
  if (existing) {
    return shiftResponse(c, services, shift, 409, formFor(services, shift, values, {}, null, selection.shiftIds), COULD_NOT_SAVE);
  }
  const turnstileToken = textField(body, 'cf-turnstile-response').trim();
  const verdict = turnstileToken === ''
    ? ({ ok: false, reason: 'rejected' } as const)
    : await checkTurnstile(services, turnstileToken, ip);
  if (!verdict.ok) {
    if (verdict.reason === 'duplicate') {
      if (!several) {
        const again = findSignupByOperation(db, tokenResult.claims.operationId);
        if (again && again.shiftId === shift.id && again.emailNorm === parsed.draft.emailNorm) {
          return redirectConfirmed(c, services, shift.id, null);
        }
      } else {
        const again = groupedOperationSignups(db, tokenResult.claims.operationId, selection.shiftIds);
        if (again?.every((row) => row.emailNorm === parsed.draft.emailNorm)) {
          return redirectGrouped(c, services, shift.id, again);
        }
      }
    }
    const notice = verdict.reason === 'unavailable' ? CHECK_UNAVAILABLE : CHECK_AGAIN;
    return shiftResponse(
      c,
      services,
      shift,
      verdict.reason === 'unavailable' ? 503 : 400,
      formFor(services, shift, values, {}, textField(body, 'form_token'), selection.shiftIds),
      notice,
    );
  }
  const emailLimit = recordSignupEmail(db, config.sessionSecret, now, config.defaultTimeZone, parsed.draft.emailNorm);
  if (emailLimit.limited) {
    return shiftResponse(
      c,
      services,
      shift,
      429,
      formFor(services, shift, values, {}, textField(body, 'form_token'), selection.shiftIds),
      TOO_MANY,
      emailLimit.retryAfter,
    );
  }
  if (several) {
    try {
      const reserved = reserveSignups(db, {
        shiftIds: selection.shiftIds,
        name: parsed.draft.name,
        email: parsed.draft.emailNorm,
        phone: parsed.draft.phone,
        notes: parsed.draft.notes,
        groupSize: parsed.draft.groupSize,
        operationId: tokenResult.claims.operationId,
        now,
        mail: mailIdentity(db, config),
      });
      if (reserved.ok) return redirectGrouped(c, services, shift.id, reserved.signups);
      return groupFailure(c, services, shift, values, textField(body, 'form_token'), selection.shiftIds, reserved.reason, reserved.shiftId);
    } catch (err) {
      if (!isBusy(err)) throw err;
      console.error('Signup could not lock the database.');
      return shiftResponse(
        c,
        services,
        shift,
        503,
        formFor(services, shift, values, {}, textField(body, 'form_token'), selection.shiftIds),
        CHECK_UNAVAILABLE,
      );
    }
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
  issued: { signupId: number; token: string; companions?: ConfirmationCompanion[] } | null,
): Response {
  if (issued) {
    const sealed = sealConfirmation(services.config.sessionSecret, {
      signupId: issued.signupId,
      shiftId,
      token: issued.token,
      expiresAtMs: epochMs(services.now()) + 900 * 1000,
      companions: issued.companions,
    });
    c.header('Set-Cookie', confirmationCookie(sealed, cookiePath(services.config), services.config.secureCookies));
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/s/${shiftId}/confirmed`), 303);
}

function redirectGrouped(
  c: Context,
  services: SignupServices,
  pageShiftId: number,
  signups: Array<{ signupId: number; shiftId: number; manageToken: string | null }>,
): Response {
  const primary = signups.find((row) => row.shiftId === pageShiftId) ?? signups[0];
  if (!primary) return html(c, services, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
  const issued = signups.every((row) => row.manageToken)
    ? {
        signupId: primary.signupId,
        token: primary.manageToken ?? '',
        companions: signups
          .filter((row) => row.shiftId !== primary.shiftId && row.manageToken)
          .map((row) => ({ signupId: row.signupId, shiftId: row.shiftId, token: row.manageToken ?? '' })),
      }
    : null;
  return redirectConfirmed(c, services, primary.shiftId, issued);
}

function groupFailure(
  c: Context,
  services: SignupServices,
  shift: PublicShift,
  values: SignupValues,
  token: string,
  selectedDateIds: number[],
  reason: 'not_found' | 'closed' | 'early' | 'full' | 'duplicate' | 'conflict',
  shiftId: number,
): Response {
  const failed = getPublicShift(services.db, shiftId, services.now());
  const label = failed ? shiftChoiceLabel(failed, shift) : undefined;
  const errors: SignupErrors = {};
  let notice: string | undefined;
  if (!failed || !label || reason === 'conflict') notice = COULD_NOT_SAVE;
  else if (reason === 'not_found') errors.dates = 'Choose a date from the list.';
  else if (reason === 'duplicate') errors.dates = `You're already signed up for ${label}. Leave that date unchecked.`;
  else if (reason === 'closed') errors.dates = `${label} is closed. Leave that date unchecked.`;
  else if (reason === 'early') errors.dates = `${label} is not open for signup yet. Leave that date unchecked.`;
  else if (reason === 'full' && failed.remaining > 0) {
    const spots = failed.remaining === 1 ? '1 spot left' : `${failed.remaining} spots left`;
    errors.dates = `${label} has ${spots}. Choose fewer people or leave that date unchecked.`;
  } else if (reason === 'full') errors.dates = `${label} is full. Leave that date unchecked.`;
  else notice = COULD_NOT_SAVE;
  return shiftResponse(
    c,
    services,
    loadShift(services, String(shift.id)) ?? shift,
    409,
    formFor(services, shift, values, errors, token, selectedDateIds),
    notice,
  );
}

function confirmedCompanions(
  services: SignupServices,
  seal: { companions?: ConfirmationCompanion[] },
): Array<{ shift: PublicShift; managePath: string | null }> {
  const views: Array<{ shift: PublicShift; managePath: string | null }> = [];
  for (const companion of seal.companions ?? []) {
    const shift = getPublicShift(services.db, companion.shiftId, services.now());
    const manage = readManageSignup(services.db, companion.token, services.now());
    if (!shift || !manage) continue;
    if (manage.signupId !== companion.signupId || manage.shiftId !== shift.id || manage.status !== 'confirmed') continue;
    views.push({ shift, managePath: appPath(services.config, `/m/${companion.token}`) });
  }
  return views;
}

function shiftChoiceLabel(shift: PublicShift, page: PublicShift): string {
  const endDate = shift.when.sameDay ? '' : `${shift.when.endDateLabel} `;
  const event = shift.event.id === page.event.id ? '' : `${shift.event.title}, `;
  return `${event}${shift.role}, ${shift.when.dateLabel}, ${shift.when.startLabel} to ${endDate}${shift.when.endLabel} ${shift.when.abbreviation}`;
}

type DateSelection = { ok: true; shiftIds: number[] } | { ok: false; error: string; shiftIds: number[] };

function readDateSelection(body: Record<string, unknown>, pageShiftId: number, choices: SignupDateChoice[]): DateSelection {
  const raw = body.dates;
  const asked = raw !== undefined || textField(body, 'dates_present') === '1';
  if (!asked) return { ok: true, shiftIds: [pageShiftId] };
  const allowed = new Set(choices.map((choice) => choice.id));
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const picked: number[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
      return { ok: false, error: 'Choose a date from the list.', shiftIds: picked };
    }
    const id = Number(value);
    if (!allowed.has(id)) return { ok: false, error: 'Choose a date from the list.', shiftIds: picked };
    if (!picked.includes(id)) picked.push(id);
  }
  if (allowed.has(pageShiftId) && !picked.includes(pageShiftId)) picked.unshift(pageShiftId);
  if (picked.length === 0) return { ok: false, error: 'Choose at least one date.', shiftIds: [] };
  if (picked.length > MAX_SIGNUP_DATES) {
    return { ok: false, error: `Choose ${MAX_SIGNUP_DATES} dates or fewer.`, shiftIds: picked.slice(0, MAX_SIGNUP_DATES) };
  }
  return { ok: true, shiftIds: choices.filter((choice) => picked.includes(choice.id)).map((choice) => choice.id) };
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
  selectedDateIds?: number[],
): SignupFormView {
  const dates = listSignupDates(services.db, shift, services.now());
  const allowed = new Set(dates.map((date) => date.id));
  const picked = (selectedDateIds ?? [shift.id]).filter((id) => allowed.has(id));
  return {
    token: token && token.length > 0 ? token : issueFormToken(services.config.sessionSecret, {
      shiftId: shift.id,
      issuedAt: epochMs(services.now()),
      operationId: newOperationId(),
    }),
    siteKey: services.config.turnstile.siteKey,
    values,
    errors,
    dates,
    selectedDateIds: picked,
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

function showManage(
  c: Context,
  services: SignupServices,
  token: string,
  status: 200 | 400 | 403 | 409 | 429 | 503 = 200,
  notice?: string,
  partyError?: string,
) {
  const signup = readManageSignup(services.db, token, services.now());
  if (!signup) return missingManage(c, services);
  const note = manageNote(c.req.query('notice'));
  return html(
    c,
    services,
    'Your signup · Hope Volunteer',
    <ManagePage
      signup={signup}
      cancel={cancelForm(services, token, signup.status, signup.ended)}
      switches={switchForm(services, token, signup)}
      party={partyForm(services, token, signup, partyError)}
      reminders={reminderForm(services, token, signup)}
      notice={notice}
      note={note}
    />,
    status,
  );
}

function manageNote(notice: string | undefined): string | undefined {
  if (notice === 'switched') return SWITCHED_NOTE;
  if (notice === 'party') return PARTY_NOTE;
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
    if (!result.ok && result.reason === 'ended') return showManage(c, services, token, 400, SHIFT_ENDED);
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
  if (signup.ended) return showManage(c, services, token, 400, SHIFT_ENDED);
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

function partyForm(
  services: SignupServices,
  token: string,
  signup: { status: 'confirmed' | 'cancelled'; ended: boolean; shiftId: number; groupSize: number },
  error?: string,
): PartyForm | null {
  if (signup.status !== 'confirmed' || signup.ended) return null;
  return {
    action: appPath(services.config, `/m/${token}/party`),
    token: issuePartyToken(services.config.sessionSecret, token),
    value: String(signup.groupSize),
    remaining: managePartyLimit(services.db, signup.shiftId, signup.groupSize),
    error,
  };
}

async function submitParty(c: Context, services: SignupServices): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const signup = readManageSignup(services.db, token, services.now());
  if (!signup) return missingManage(c, services);
  if (!originAllowed(c, services.config.baseUrl)) {
    return showManage(c, services, token, 403, PARTY_ORIGIN);
  }
  const body = await c.req.parseBody();
  if (!partyTokenMatches(services.config.sessionSecret, token, textField(body, 'party_token'))) {
    return showManage(c, services, token, 400, PARTY_REJECTED);
  }
  if (signup.status !== 'confirmed') return showManage(c, services, token, 400, 'This signup is cancelled.');
  if (signup.ended) return showManage(c, services, token, 400, SHIFT_ENDED);
  const raw = textField(body, 'party_size');
  const parsed = raw.trim().length === 0
    ? { ok: false as const, error: 'Choose how many people are coming.' }
    : parsePartySize(raw);
  if (!parsed.ok) return showManage(c, services, token, 400, undefined, parsed.error);
  try {
    const result = changePartySize(services.db, token, parsed.groupSize, services.now(), mailIdentity(services.db, services.config));
    if (!result.ok && result.reason === 'cancelled') return showManage(c, services, token, 400, 'This signup is cancelled.');
    if (!result.ok && result.reason === 'ended') return showManage(c, services, token, 400, SHIFT_ENDED);
    if (!result.ok && result.reason === 'full') {
      const spotsLeft = result.spotsLeft ?? 0;
      return showManage(c, services, token, 409, undefined, spotsLeft > 0 ? spotsLeftMessage(spotsLeft) : FULL);
    }
    if (!result.ok) return showManage(c, services, token, 400, PARTY_REJECTED);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Head count could not lock the database.');
    return showManage(c, services, token, 503, PARTY_UNAVAILABLE);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/m/${token}?notice=party`), 303);
}

function switchForm(services: SignupServices, token: string, signup: { status: 'confirmed' | 'cancelled'; ended: boolean; shiftId: number; eventId: number; name: string; email: string; groupSize: number }): SwitchForm | null {
  if (signup.status !== 'confirmed' || signup.ended) return null;
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
): { action: string; token: string; on: boolean } | null {
  if (signup.status !== 'confirmed') return null;
  return {
    action: appPath(services.config, `/m/${token}/reminders`),
    token: issueReminderPageToken(services.config.sessionSecret, token),
    on: !signup.remindersOff,
  };
}

async function submitReminders(c: Context, services: SignupServices): Promise<Response> {
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
  const on = textField(body, 'reminders') === 'on';
  try {
    const result = on
      ? enableReminders(services.db, signup.signupId, services.now())
      : disableReminders(services.db, signup.signupId, services.now());
    if (!result.ok) return missingManage(c, services);
    if (on) queueDueReminders(services.db, mailIdentity(services.db, services.config), services.config.sessionSecret, services.now());
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Reminder setting could not lock the database.');
    return showManage(c, services, token, 503, CANCEL_UNAVAILABLE);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(appPath(services.config, `/m/${token}`), 303);
}

function cancelForm(
  services: SignupServices,
  token: string,
  status: 'confirmed' | 'cancelled',
  ended: boolean,
): { action: string; token: string } | null {
  if (status !== 'confirmed' || ended) return null;
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
