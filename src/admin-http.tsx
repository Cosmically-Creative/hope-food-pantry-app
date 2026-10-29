import { Temporal } from '@js-temporal/polyfill';
import { getConnInfo } from '@hono/node-server/conninfo';
import type Database from 'better-sqlite3';
import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';
import {
  eventValuesFrom,
  parseEvent,
  parseShift,
  parseTemplate,
  shiftValuesFrom,
  templateValuesFrom,
  type EventValues,
  type ShiftValues,
  type TemplateValues,
} from './admin/forms.js';
import {
  addWalkIn,
  cancelShift,
  cancelSignupAsCoordinator,
  createEvent,
  createShift,
  createTemplate,
  deleteCancelledSignup,
  deleteCancelledSignups,
  deleteEvent,
  deleteEndedTemplate,
  deleteFinishedShift,
  deleteFinishedShifts,
  endTemplate,
  findSignupShift,
  getAdminEvent,
  getAdminShift,
  getAdminTemplate,
  listHomeBoard,
  readEventRemoval,
  readShiftRemoval,
  readSignupRemoval,
  readTemplateRemoval,
  listMoveTargets,
  listOpenShiftsForPerson,
  moveSignup,
  updateEvent,
  updateShift,
  updateTemplate,
} from './admin/store.js';
import {
  AdminHome,
  EventEditor,
  eventRemovalPrompt,
  LoginConfirmPage,
  LoginPage,
  MessagePage,
  shiftCancelPrompt,
  shiftRemovalPrompt,
  signupCancelPrompt,
  signupRemovalPrompt,
  templateEndPrompt,
  templateRemovalPrompt,
  type ConfirmPrompt,
  adminRemovalPrompt,
  contactRemovalPrompt,
  ContactPage,
  ContactsPage,
  AdminsPage,
  SettingsPage,
  ShiftEditor,
  ShiftRoster,
  TemplateEditor,
  type WalkInState,
} from './admin-pages.js';
import { addAdmin, deactivateAdmin, listAdmins, readAdminRemoval, type AdminErrors, type AdminForm } from './admins.js';
import { writeAudit } from './auth/audit.js';
import { consumeLoginLink, issueLoginProof, loginLinkOpen, loginProofMatches, requestMagicLink } from './auth/login.js';
import { csrfMatches, readSession, revokeSession, sessionClearCookie, sessionSetCookie, type CoordinatorSession } from './auth/session.js';
import { clientAddress } from './client-ip.js';
import type { AppConfig } from './config.js';
import { normalizeEmail } from './email.js';
import type { MailIdentity } from './mail/types.js';
import { issueFormToken, newOperationId, readFormToken } from './form-token.js';
import {
  contactListLimit,
  correctContact,
  exportContacts,
  formatContactSkips,
  getContact,
  importContactCsv,
  loadContacts,
  parseContactSkips,
  removeContact,
  saveManualContact,
  contactSignupShifts,
  walkInFromContact,
  type ContactImportSummary,
  type ContactManualErrors,
  type ContactManualValues,
} from './contacts.js';
import { dateStamp, exportDateRange, exportEventRoster, exportShiftRoster } from './export.js';
import { originAllowed } from './origin.js';
import {
  parseSettingsForm,
  readPantrySettings,
  readReplyTo,
  savePantrySettings,
  settingsFormFrom,
  type SettingsErrors,
  type SettingsForm,
} from './settings.js';
import { expandTemplates } from './recurrence.js';
import { Layout } from './pages.js';
import { EMPTY_SIGNUP, parseSignupForm, spotsLeftMessage, type SignupValues } from './signup-form.js';
import { confirmedPersonOnShift } from './signup.js';
import { recordInvalidLoginToken, recordLoginEmail, recordLoginIp } from './rate-limit.js';
import { isBusy } from './sqlite-error.js';
import { verifyTurnstile, type TurnstileCheck, type TurnstileVerdict } from './turnstile.js';
import { backupDirectory, describeBackup } from './jobs/backup.js';
import { appPath } from './url.js';

const LINK_UNAVAILABLE = 'This sign-in link is not available.';
const TOO_MANY = 'Too many sign-in attempts. Wait and try again.';
const ORIGIN = 'The sign-in request could not be sent from this page.';
const EMAIL_INVALID = 'Enter an email address.';
const CHECK_FAILED = 'The check did not finish.';
const CHECK_DOWN = 'The check is unavailable. Try again in a few minutes.';
const STALE = 'This form is out of date. Go back and try again.';
const SAVE_BUSY = 'The form could not be saved. Try again.';

export type AdminServices = {
  config: AppConfig;
  db: Database.Database;
  now: () => string;
  clientIp?: (c: Context) => string | null;
  verifyTurnstile?: (input: TurnstileCheck) => Promise<TurnstileVerdict>;
};

export function registerAdmin(app: Hono, services: AdminServices): void {
  const { config } = services;
  app.get(appPath(config, '/login'), (c) => html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} />, { turnstile: true }));
  app.post(appPath(config, '/login'), (c) => submitLogin(c, services));
  app.get(appPath(config, '/login/link/:token'), (c) => showLoginLink(c, services));
  app.post(appPath(config, '/login/link/:token'), (c) => submitLoginLink(c, services));
  app.post(appPath(config, '/logout'), (c) => submitLogout(c, services));
  app.get(appPath(config, '/admin'), (c) => showHome(c, services));
  app.get(appPath(config, '/admin/settings'), (c) => showSettings(c, services));
  app.post(appPath(config, '/admin/settings'), (c) => submitSettings(c, services));
  app.get(appPath(config, '/admin/admins'), (c) => showAdmins(c, services));
  app.post(appPath(config, '/admin/admins'), (c) => submitNewAdmin(c, services));
  app.get(appPath(config, '/admin/admins/:id/remove'), (c) => showRemoveAdmin(c, services));
  app.post(appPath(config, '/admin/admins/:id/remove'), (c) => submitRemoveAdmin(c, services));
  app.post(appPath(config, '/admin/export'), (c) => submitExportRange(c, services));
  app.get(appPath(config, '/admin/contacts'), (c) => showContacts(c, services));
  app.post(appPath(config, '/admin/contacts/new'), (c) => submitNewContact(c, services));
  app.post(appPath(config, '/admin/contacts/import'), (c) => submitImportContacts(c, services));
  app.post(appPath(config, '/admin/contacts/export'), (c) => submitExportContacts(c, services));
  app.get(appPath(config, '/admin/contacts/:id/remove'), (c) => showRemoveContact(c, services));
  app.post(appPath(config, '/admin/contacts/:id/remove'), (c) => submitRemoveContact(c, services));
  app.post(appPath(config, '/admin/contacts/:id/add'), (c) => submitAddContactToShift(c, services));
  app.get(appPath(config, '/admin/contacts/:id'), (c) => showContact(c, services));
  app.post(appPath(config, '/admin/contacts/:id'), (c) => submitCorrectContact(c, services));
  app.get(appPath(config, '/admin/events/new'), (c) => showNewEvent(c, services));
  app.post(appPath(config, '/admin/events'), (c) => submitNewEvent(c, services));
  app.get(appPath(config, '/admin/events/:id/remove'), (c) => showRemoveEvent(c, services));
  app.post(appPath(config, '/admin/events/:id/remove'), (c) => submitRemoveEvent(c, services));
  app.get(appPath(config, '/admin/events/:id'), (c) => showEvent(c, services));
  app.post(appPath(config, '/admin/events/:id/export'), (c) => submitExportEvent(c, services));
  app.post(appPath(config, '/admin/events/:id'), (c) => submitEvent(c, services));
  app.post(appPath(config, '/admin/events/:id/generate'), (c) => generateWeeklyShifts(c, services));
  app.get(appPath(config, '/admin/events/:id/templates/new'), (c) => showNewTemplate(c, services));
  app.post(appPath(config, '/admin/events/:id/templates'), (c) => submitNewTemplate(c, services));
  app.get(appPath(config, '/admin/events/:id/templates/:templateId'), (c) => showTemplate(c, services));
  app.get(appPath(config, '/admin/events/:id/templates/:templateId/end'), (c) => showEndTemplate(c, services));
  app.post(appPath(config, '/admin/events/:id/templates/:templateId/end'), (c) => submitEndTemplate(c, services));
  app.get(appPath(config, '/admin/events/:id/templates/:templateId/remove'), (c) => showRemoveTemplate(c, services));
  app.post(appPath(config, '/admin/events/:id/templates/:templateId/remove'), (c) => submitRemoveTemplate(c, services));
  app.post(appPath(config, '/admin/events/:id/templates/:templateId'), (c) => submitTemplate(c, services));
  app.get(appPath(config, '/admin/events/:id/shifts/new'), (c) => showNewShift(c, services));
  app.post(appPath(config, '/admin/events/:id/shifts/remove'), (c) => submitRemoveShifts(c, services));
  app.post(appPath(config, '/admin/events/:id/shifts'), (c) => submitNewShift(c, services));
  app.get(appPath(config, '/admin/shifts/:id'), (c) => showShift(c, services));
  app.post(appPath(config, '/admin/shifts/:id/export'), (c) => submitExportShift(c, services));
  app.post(appPath(config, '/admin/shifts/:id'), (c) => submitShift(c, services));
  app.post(appPath(config, '/admin/shifts/:id/walk-in'), (c) => submitWalkIn(c, services));
  app.get(appPath(config, '/admin/shifts/:id/cancel'), (c) => showCancelShift(c, services));
  app.post(appPath(config, '/admin/shifts/:id/cancel'), (c) => submitCancelShift(c, services));
  app.get(appPath(config, '/admin/shifts/:id/remove'), (c) => showRemoveShift(c, services));
  app.post(appPath(config, '/admin/shifts/:id/signups/remove'), (c) => submitRemoveSignups(c, services));
  app.post(appPath(config, '/admin/shifts/:id/remove'), (c) => submitRemoveShift(c, services));
  app.get(appPath(config, '/admin/signups/:id/remove'), (c) => showRemoveSignup(c, services));
  app.post(appPath(config, '/admin/signups/:id/remove'), (c) => submitRemoveSignup(c, services));
  app.get(appPath(config, '/admin/signups/:id/cancel'), (c) => showCancelSignup(c, services));
  app.post(appPath(config, '/admin/signups/:id/cancel'), (c) => submitCancelSignup(c, services));
  app.post(appPath(config, '/admin/signups/:id/move'), (c) => submitMove(c, services));
}

async function submitLogin(c: Context, services: AdminServices): Promise<Response> {
  const { config, db } = services;
  const now = services.now();
  const ip = clientAddress(config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  if (!originAllowed(c, config.baseUrl)) {
    return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} error={ORIGIN} />, { status: 403, turnstile: true });
  }
  const ipLimit = recordLoginIp(db, config.sessionSecret, now, ip);
  if (ipLimit.limited) return loginWait(c, services, ipLimit.retryAfter);
  const body = await c.req.parseBody();
  if (textField(body, 'company_website').trim() !== '') {
    return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} accepted />);
  }
  let email = '';
  try {
    email = normalizeEmail(textField(body, 'email'));
  } catch {
    return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} error={EMAIL_INVALID} />, { status: 400, turnstile: true });
  }
  const verdict = await checkTurnstile(services, textField(body, 'cf-turnstile-response'), ip);
  if (!verdict.ok) {
    const message = verdict.reason === 'unavailable' ? CHECK_DOWN : CHECK_FAILED;
    const status = verdict.reason === 'unavailable' ? 503 : 400;
    return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} error={message} />, { status, turnstile: true });
  }
  const emailLimit = recordLoginEmail(db, config.sessionSecret, now, email);
  if (emailLimit.limited) return loginWait(c, services, emailLimit.retryAfter);
  try {
    requestMagicLink(db, { email, now, mail: mailIdentity(db, config) });
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Sign-in could not lock the database.');
    return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} error={SAVE_BUSY} />, { status: 503, turnstile: true });
  }
  return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={config} accepted />);
}

function showLoginLink(c: Context, services: AdminServices) {
  const token = c.req.param('token') ?? '';
  if (!loginLinkOpen(services.db, token, services.now())) {
    return html(c, services, 'Sign in · Hope Volunteer', <MessagePage heading="Sign in" message={LINK_UNAVAILABLE} />, { status: 404 });
  }
  return html(
    c,
    services,
    'Sign in · Hope Volunteer',
    <LoginConfirmPage action={appPath(services.config, `/login/link/${token}`)} proof={issueLoginProof(services.config.sessionSecret, token)} />,
  );
}

async function submitLoginLink(c: Context, services: AdminServices): Promise<Response> {
  const { config, db } = services;
  const now = services.now();
  const token = c.req.param('token') ?? '';
  const ip = clientAddress(config.trustProxy, peerAddress(c, services.clientIp), c.req.header('x-forwarded-for'));
  if (!originAllowed(c, config.baseUrl)) {
    return html(c, services, 'Sign in · Hope Volunteer', <MessagePage heading="Sign in" message={ORIGIN} />, { status: 403 });
  }
  const body = await c.req.parseBody();
  if (!loginProofMatches(config.sessionSecret, token, textField(body, 'proof'))) return rejectLink(c, services, ip);
  let result: ReturnType<typeof consumeLoginLink>;
  try {
    result = consumeLoginLink(db, token, now);
  } catch (err) {
    if (!isBusy(err)) throw err;
    console.error('Sign-in could not lock the database.');
    return html(c, services, 'Sign in · Hope Volunteer', <MessagePage heading="Sign in" message={SAVE_BUSY} />, { status: 503 });
  }
  if (!result.ok) return rejectLink(c, services, ip);
  c.header('Set-Cookie', sessionSetCookie(config, result.sessionToken));
  return c.redirect(appPath(config, '/admin'), 303);
}

async function submitLogout(c: Context, services: AdminServices): Promise<Response> {
  const session = readSession(services.db, c.req.header('cookie'), services.now());
  if (!session || !originAllowed(c, services.config.baseUrl)) {
    return c.redirect(appPath(services.config, '/login'), 303);
  }
  const body = await c.req.parseBody();
  if (!csrfMatches(session.csrf, textField(body, 'csrf'))) {
    return html(c, services, 'Coordinator · Hope Volunteer', <MessagePage heading="Coordinator" message={STALE} />, { status: 403, account: session });
  }
  revokeSession(services.db, c.req.header('cookie'));
  c.header('Set-Cookie', sessionClearCookie(services.config));
  return c.redirect(appPath(services.config, '/login'), 303);
}

function showHome(
  c: Context,
  services: AdminServices,
  exportError?: string,
  range?: { from: string; to: string },
  status: 200 | 400 | 403 = 200,
  newEvent?: { values: EventValues; error?: string },
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const notice = knownNotice(c.req.query('notice'));
  const now = services.now();
  const backup = describeBackup(backupDirectory(services.config.dataDir), now);
  const board = listHomeBoard(services.db, now, services.config.defaultTimeZone);
  return html(
    c,
    services,
    newEvent ? 'New event · Hope Volunteer' : 'Coordinator · Hope Volunteer',
    <AdminHome
      config={services.config}
      name={session.name}
      events={board.events}
      shifts={board.shifts}
      now={now}
      csrf={session.csrf}
      notice={notice}
      exportFrom={range?.from}
      exportTo={range?.to}
      exportError={exportError}
      backupNote={backup.text}
      backupState={backup.state}
      backupSavedToday={backup.savedToday}
      sessionEndsAt={session.expiresAt}
      newEvent={newEvent}
    />,
    { account: session, status },
  );
}

async function submitExportRange(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const from = textField(session.body, 'from');
  const to = textField(session.body, 'to');
  const exported = exportDateRange(services.db, from, to);
  if (!exported.ok) return showHome(c, services, exported.error, { from, to }, 400);
  const fromStamp = dateStamp(from);
  const toStamp = dateStamp(to);
  writeAudit(
    services.db,
    session.coordinatorId,
    'roster.export',
    { from: fromStamp ?? 0, to: toStamp ?? 0, rows: exported.export.rows },
    services.now(),
  );
  return csvDownload(c, `hope-roster-${from}-to-${to}.csv`, exported.export.csv);
}

async function submitExportEvent(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const exported = exportEventRoster(services.db, eventId);
  if (!exported) return missing(c, services);
  writeAudit(services.db, session.coordinatorId, 'roster.export', { eventId, rows: exported.rows }, services.now());
  return csvDownload(c, `hope-event-${eventId}.csv`, exported.csv);
}

async function submitExportShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const shiftId = idFrom(c);
  const exported = exportShiftRoster(services.db, shiftId);
  if (!exported) return missing(c, services);
  writeAudit(services.db, session.coordinatorId, 'roster.export', { shiftId, rows: exported.rows }, services.now());
  return csvDownload(c, `hope-shift-${shiftId}.csv`, exported.csv);
}

function showContacts(
  c: Context,
  services: AdminServices,
  options?: {
    error?: string;
    status?: 200 | 400 | 403;
    confirm?: ConfirmPrompt;
    manual?: { values: ContactManualValues; errors: ContactManualErrors };
  },
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const loaded = loadContacts(services.db, c.req.query('q') ?? '');
  return html(
    c,
    services,
    'Contacts · Hope Volunteer',
    <ContactsPage
      config={services.config}
      csrf={session.csrf}
      people={loaded.people}
      total={loaded.total}
      query={loaded.query}
      limit={contactListLimit(c.req.query('shown'))}
      notice={options?.error ? undefined : knownNotice(c.req.query('notice'))}
      summary={options?.error ? undefined : contactSummary(c)}
      importError={options?.error}
      manual={options?.manual}
      confirm={options?.confirm}
    />,
    { account: session, status: options?.status ?? 200 },
  );
}

async function submitNewContact(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const values = {
    firstName: textField(session.body, 'first_name'),
    lastName: textField(session.body, 'last_name'),
    email: textField(session.body, 'email'),
    phone: textField(session.body, 'phone'),
  };
  try {
    const saved = saveManualContact(services.db, session.coordinatorId, values, services.now());
    if (!saved.ok) return showContacts(c, services, { status: 400, manual: { values, errors: saved.errors } });
    const notice = saved.status === 'added' ? 'contact-saved' : saved.status === 'changed' ? 'contact-updated' : 'contact-matched';
    return c.redirect(appPath(services.config, `/admin/contacts?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitImportContacts(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const text = await csvFromField(session.body.file);
  if (text === null) return showContacts(c, services, { error: 'Choose a spreadsheet to import.', status: 400 });
  try {
    const imported = importContactCsv(services.db, session.coordinatorId, text, services.now());
    if (!imported.ok) return showContacts(c, services, { error: imported.error, status: 400 });
    return c.redirect(importLocation(services.config, imported.result), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitExportContacts(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const exported = exportContacts(services.db);
  writeAudit(services.db, session.coordinatorId, 'contacts.export', { rows: exported.rows }, services.now());
  return csvDownload(c, 'hope-contacts.csv', exported.csv);
}

function showRemoveContact(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const contact = getContact(services.db, idFrom(c));
  if (!contact) return missing(c, services);
  const prompt = contactRemovalPrompt(contact);
  return showContacts(c, services, {
    status,
    confirm: {
      ...prompt,
      body: error && error !== prompt.body ? error : prompt.body,
      submit: error ? undefined : prompt.submit,
      error: error && error !== prompt.body ? error : undefined,
      action: appPath(services.config, `/admin/contacts/${contact.id}/remove`),
    },
  });
}

function showContact(
  c: Context,
  services: AdminServices,
  state?: {
    error?: string;
    status?: 200 | 400;
    form?: WalkInState;
    shiftId?: string;
    correction?: { values: ContactManualValues; errors: ContactManualErrors };
  },
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const contact = getContact(services.db, idFrom(c));
  if (!contact) return missing(c, services);
  return html(
    c,
    services,
    `${contact.name} · Hope Volunteer`,
    <ContactPage
      config={services.config}
      csrf={session.csrf}
      contact={contact}
      signedUp={contactSignupShifts(services.db, contact, services.now())}
      shifts={listOpenShiftsForPerson(services.db, { email: contact.email, name: contact.name }, services.now())}
      form={state?.form ?? blankWalkIn(services, contact.id)}
      shiftId={state?.shiftId ?? ''}
      notice={state?.status === 400 ? undefined : knownNotice(c.req.query('notice'))}
      correction={state?.correction}
      error={state?.error}
    />,
    { account: session, status: state?.status ?? 200 },
  );
}

async function submitCorrectContact(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  const values = {
    firstName: textField(session.body, 'first_name'),
    lastName: textField(session.body, 'last_name'),
    email: textField(session.body, 'email'),
    phone: textField(session.body, 'phone'),
  };
  try {
    const saved = correctContact(services.db, session.coordinatorId, id, values, services.now());
    if (!saved.ok) {
      if ('missing' in saved) return missing(c, services);
      return showContact(c, services, { status: 400, correction: { values, errors: saved.errors } });
    }
    const notice = saved.status === 'changed' ? 'contact-corrected' : 'contact-same';
    return c.redirect(appPath(services.config, `/admin/contacts/${id}?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function contactShiftUnavailable(c: Context, services: AdminServices, email: string, name: string, shiftId: number, form: WalkInState) {
  const already = shiftId > 0 && confirmedPersonOnShift(services.db, shiftId, email, name);
  return showContact(c, services, {
    error: already ? 'That person is already signed up for this shift.' : 'That shift is not open.',
    status: 400,
    form,
    shiftId: '',
  });
}

async function submitAddContactToShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const contact = getContact(services.db, idFrom(c));
  if (!contact) return missing(c, services);
  const shiftId = wholeId(textField(session.body, 'shift'));
  const entered = signupValuesFrom(session.body);
  const filled = walkInFromContact(contact, { ...entered, name: '', email: '', phone: '' });
  const postedToken = textField(session.body, 'form_token');
  if (shiftId === 0) {
    return showContact(c, services, {
      error: 'Choose a shift.',
      status: 400,
      form: blankWalkIn(services, contact.id, filled),
      shiftId: '',
    });
  }
  const shift = listOpenShiftsForPerson(services.db, { email: contact.email, name: contact.name }, services.now()).find(
    (choice) => choice.id === shiftId,
  );
  if (!shift) return contactShiftUnavailable(c, services, contact.email, contact.name, shiftId, blankWalkIn(services, contact.id, filled));
  // Bound to this contact. The shift is the Shift field, so one token covers every choice in the menu.
  const token = readFormToken(services.config.sessionSecret, postedToken, contact.id, Date.parse(services.now()), 0);
  if (!token.ok) {
    return showContact(c, services, {
      status: 400,
      form: blankWalkIn(services, contact.id, filled, {}, 'This form is out of date. Submit it again.'),
      shiftId: String(shiftId),
    });
  }
  const parsed = parseSignupForm(filled, 'coordinator');
  if (!parsed.ok) {
    return showContact(c, services, {
      status: 400,
      form: blankWalkIn(services, contact.id, filled, parsed.errors),
      shiftId: String(shiftId),
    });
  }
  try {
    const saved = addWalkIn(services.db, session.coordinatorId, {
      shiftId,
      name: parsed.draft.name,
      email: parsed.draft.emailNorm,
      phone: parsed.draft.phone,
      notes: parsed.draft.notes,
      groupSize: parsed.draft.groupSize,
      operationId: token.claims.operationId,
      now: services.now(),
      mail: mailIdentity(services.db, services.config),
    });
    if (saved.ok) return c.redirect(appPath(services.config, `/admin/shifts/${shiftId}?notice=walk-in`), 303);
    if (saved.reason === 'duplicate') {
      return showContact(c, services, { error: 'That person is already signed up for this shift.', status: 400 });
    }
    if (saved.reason === 'not_found' || saved.reason === 'closed' || saved.reason === 'full') {
      return showContact(c, services, { error: 'That shift is not open.', status: 400 });
    }
    return showContact(c, services, {
      status: 400,
      form: blankWalkIn(services, contact.id, filled, {}, 'This form was already used for a different signup. Submit it again.'),
      shiftId: String(shiftId),
    });
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitRemoveContact(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  try {
    const removed = removeContact(services.db, session.coordinatorId, id, services.now());
    if (!removed) return missing(c, services);
    return c.redirect(appPath(services.config, '/admin/contacts?notice=contact-removed'), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function csvDownload(c: Context, filename: string, csv: string): Response {
  return c.body(new TextEncoder().encode(csv), 200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

function showSettings(c: Context, services: AdminServices, values?: SettingsForm, errors?: SettingsErrors, status: 200 | 400 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const current = settingsFormFrom(readPantrySettings(services.db, services.config.mail.replyTo));
  return html(
    c,
    services,
    'Settings · Hope Volunteer',
    <SettingsPage
      config={services.config}
      csrf={session.csrf}
      values={values ?? current}
      errors={errors}
      notice={knownNotice(c.req.query('notice'))}
    />,
    { account: session, status },
  );
}

async function submitSettings(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const form = settingsFormFromBody(session.body);
  const parsed = parseSettingsForm(form);
  if (!parsed.ok) return showSettings(c, services, form, parsed.errors, 400);
  try {
    savePantrySettings(services.db, session.coordinatorId, parsed.value, services.config.mail.replyTo, services.now());
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
  return c.redirect(appPath(services.config, '/admin/settings?notice=settings-saved'), 303);
}

function showAdmins(
  c: Context,
  services: AdminServices,
  state?: { values?: AdminForm; errors?: AdminErrors; status?: 200 | 400 | 403; confirm?: ConfirmPrompt },
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  return html(
    c,
    services,
    'Administrators · Hope Volunteer',
    <AdminsPage
      config={services.config}
      csrf={session.csrf}
      currentId={session.coordinatorId}
      admins={listAdmins(services.db)}
      notice={state?.status === 400 ? undefined : knownNotice(c.req.query('notice'))}
      form={state?.values ? { values: state.values, errors: state.errors ?? {} } : undefined}
      confirm={state?.confirm}
    />,
    { account: session, status: state?.status ?? 200 },
  );
}

async function submitNewAdmin(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const values = { name: textField(session.body, 'name'), email: textField(session.body, 'email') };
  try {
    const saved = addAdmin(services.db, session.coordinatorId, values, services.now());
    if (!saved.ok) return showAdmins(c, services, { values, errors: saved.errors, status: 400 });
    const notice = saved.status === 'restored' ? 'admin-restored' : 'admin-added';
    return c.redirect(appPath(services.config, `/admin/admins?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveAdmin(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const removal = readAdminRemoval(services.db, idFrom(c));
  if (!removal) return missing(c, services);
  const prompt = adminRemovalPrompt({
    name: removal.admin.name,
    email: removal.admin.email,
    self: removal.admin.id === session.coordinatorId,
    last: removal.last,
  });
  return showAdmins(c, services, {
    status,
    confirm: {
      ...prompt,
      body: error && error !== prompt.body ? error : prompt.body,
      submit: error ? undefined : prompt.submit,
      error: error && error !== prompt.body ? error : undefined,
      action: appPath(services.config, `/admin/admins/${removal.admin.id}/remove`),
    },
  });
}

async function submitRemoveAdmin(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  try {
    const removed = deactivateAdmin(services.db, session.coordinatorId, id, services.now());
    if (!removed.ok) {
      if (removed.reason === 'missing') return missing(c, services);
      return showRemoveAdmin(c, services, 'Add another administrator before removing this one.', 400);
    }
    if (id === session.coordinatorId) {
      c.header('Set-Cookie', sessionClearCookie(services.config));
      return c.redirect(appPath(services.config, '/login'), 303);
    }
    return c.redirect(appPath(services.config, '/admin/admins?notice=admin-removed'), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function settingsFormFromBody(body: Record<string, unknown>): SettingsForm {
  return {
    reminderFar: textField(body, 'reminder_far'),
    reminderNear: textField(body, 'reminder_near'),
    replyTo: textField(body, 'reply_to'),
    retentionMonths: textField(body, 'retention_months'),
    privacyText: textField(body, 'privacy_text'),
  };
}

function showNewEvent(c: Context, services: AdminServices, values?: EventValues, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  return showHome(c, services, undefined, undefined, status, {
    values: values ?? blankEvent(services.config.defaultTimeZone),
    error,
  });
}

async function submitNewEvent(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const values = eventValuesFrom(session.body, services.config.defaultTimeZone);
  const parsed = parseEvent(values);
  if (!parsed.ok) return showNewEvent(c, services, values, parsed.error, 400);
  try {
    const saved = createEvent(services.db, session.coordinatorId, parsed.value, services.now());
    if (!saved.ok) return showNewEvent(c, services, values, saved.error, 400);
    return c.redirect(appPath(services.config, `/admin/events/${saved.id}?notice=saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showEvent(
  c: Context,
  services: AdminServices,
  error?: string,
  status: 200 | 400 | 403 = 200,
  confirm?: ConfirmPrompt,
  eventId = idFrom(c),
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const event = getAdminEvent(services.db, eventId);
  if (!event) return missing(c, services);
  return html(
    c,
    services,
    `${event.title} · Hope Volunteer`,
    <EventEditor
      config={services.config}
      heading={event.title}
      action={appPath(services.config, `/admin/events/${event.id}`)}
      csrf={session.csrf}
      values={{
        title: event.title,
        slug: event.slug,
        description: event.description,
        location: event.location,
        tz: event.tz,
        published: event.published,
      }}
      event={event}
      error={error}
      notice={knownNotice(c.req.query('notice'))}
      now={services.now()}
      submitLabel="Save event"
      confirm={confirm}
    />,
    { account: session, status },
  );
}

async function generateWeeklyShifts(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  const event = getAdminEvent(services.db, id);
  if (!event) return missing(c, services);
  try {
    const result = expandTemplates(services.db, services.now(), { eventId: id, coordinatorId: session.coordinatorId });
    if (result.templates === 0) {
      return c.redirect(appPath(services.config, `/admin/events/${id}?notice=no-template`), 303);
    }
    if (result.skipped.length > 0) {
      return html(
        c,
        services,
        `${event.title} · Hope Volunteer`,
        <EventEditor
          config={services.config}
          heading={event.title}
          action={appPath(services.config, `/admin/events/${event.id}`)}
          csrf={session.csrf}
          values={{
            title: event.title,
            slug: event.slug,
            description: event.description,
            location: event.location,
            tz: event.tz,
            published: event.published,
          }}
          event={getAdminEvent(services.db, id) ?? event}
          generateNote={result.skipped.join(' ')}
          now={services.now()}
          submitLabel="Save event"
        />,
        { account: session, status: 200 },
      );
    }
    return c.redirect(appPath(services.config, `/admin/events/${id}?notice=generated`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitEvent(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  const values = eventValuesFrom(session.body, services.config.defaultTimeZone);
  const parsed = parseEvent(values);
  if (!parsed.ok) return showEventEditor(c, services, session, id, values, parsed.error);
  try {
    const saved = updateEvent(services.db, session.coordinatorId, id, parsed.value, services.now(), mailIdentity(services.db, services.config));
    if (!saved.ok) return showEventEditor(c, services, session, id, values, saved.error);
    return c.redirect(appPath(services.config, `/admin/events/${id}?notice=saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showNewTemplate(c: Context, services: AdminServices, values?: TemplateValues, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const event = getAdminEvent(services.db, idFrom(c));
  if (!event) return missing(c, services);
  return html(
    c,
    services,
    'New weekly template · Hope Volunteer',
    <TemplateEditor
      config={services.config}
      heading={`New weekly template for ${event.title}`}
      action={appPath(services.config, `/admin/events/${event.id}/templates`)}
      csrf={session.csrf}
      values={values ?? blankTemplate(localToday(event.tz, services.now()))}
      eventId={event.id}
      eventTitle={event.title}
      error={error}
      submitLabel="Save template"
    />,
    { account: session, status },
  );
}

async function submitNewTemplate(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const values = templateValuesFrom(session.body);
  const parsed = parseTemplate(values);
  if (!parsed.ok) return showNewTemplate(c, services, values, parsed.error, 400);
  try {
    const saved = createTemplate(services.db, session.coordinatorId, eventId, parsed.value, services.now());
    if (!saved.ok) return showNewTemplate(c, services, values, saved.error, 400);
    return c.redirect(appPath(services.config, `/admin/events/${eventId}?notice=template-saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showTemplate(c: Context, services: AdminServices, values?: TemplateValues, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const event = getAdminEvent(services.db, eventId);
  const template = getAdminTemplate(services.db, eventId, templateIdFrom(c));
  if (!event || !template) return missing(c, services);
  return html(
    c,
    services,
    'Edit weekly template · Hope Volunteer',
    <TemplateEditor
      config={services.config}
      heading={template.active ? 'Edit weekly template' : 'Weekly template'}
      action={appPath(services.config, `/admin/events/${eventId}/templates/${template.id}`)}
      csrf={session.csrf}
      values={
        values ?? {
          role: template.role,
          weekday: String(template.weekday),
          start: template.start,
          end: template.end,
          capacity: String(template.capacity),
          startsOn: template.startsOn,
          endsOn: template.endsOn ?? '',
        }
      }
      eventId={eventId}
      eventTitle={event.title}
      ended={!template.active}
      error={error}
      submitLabel="Save template"
    />,
    { account: session, status },
  );
}

async function submitTemplate(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const templateId = templateIdFrom(c);
  const values = templateValuesFrom(session.body);
  const parsed = parseTemplate(values);
  if (!parsed.ok) return showTemplate(c, services, values, parsed.error, 400);
  try {
    const saved = updateTemplate(services.db, session.coordinatorId, eventId, templateId, parsed.value, services.now());
    if (!saved.ok) return showTemplate(c, services, values, saved.error, 400);
    return c.redirect(appPath(services.config, `/admin/events/${eventId}?notice=template-saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showEndTemplate(c: Context, services: AdminServices) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const template = readTemplateRemoval(services.db, idFrom(c), templateIdFrom(c));
  if (!template) return missing(c, services);
  return showEvent(
    c,
    services,
    undefined,
    200,
    {
      ...templateEndPrompt(template),
      action: appPath(services.config, `/admin/events/${template.eventId}/templates/${template.id}/end`),
    },
    template.eventId,
  );
}

async function submitEndTemplate(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const templateId = templateIdFrom(c);
  try {
    const ended = endTemplate(services.db, session.coordinatorId, eventId, templateId, services.now());
    if (!ended.ok) return missing(c, services);
    return c.redirect(appPath(services.config, `/admin/events/${eventId}?notice=template-ended`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveEvent(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const event = readEventRemoval(services.db, idFrom(c));
  if (!event) return missing(c, services);
  return showEvent(
    c,
    services,
    undefined,
    status,
    {
      ...eventRemovalPrompt(event, error),
      action: appPath(services.config, `/admin/events/${event.id}/remove`),
    },
    event.id,
  );
}

async function submitRemoveEvent(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  try {
    const removed = deleteEvent(services.db, session.coordinatorId, eventId, services.now());
    if (!removed.ok) {
      if (removed.error === 'That event is not available.') return missing(c, services);
      return showRemoveEvent(c, services, removed.error, 400);
    }
    return c.redirect(appPath(services.config, '/admin?notice=event-removed'), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveTemplate(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const template = readTemplateRemoval(services.db, idFrom(c), templateIdFrom(c));
  if (!template) return missing(c, services);
  return showEvent(
    c,
    services,
    undefined,
    status,
    {
      ...templateRemovalPrompt(template, error),
      action: appPath(services.config, `/admin/events/${template.eventId}/templates/${template.id}/remove`),
    },
    template.eventId,
  );
}

async function submitRemoveTemplate(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const templateId = templateIdFrom(c);
  try {
    const removed = deleteEndedTemplate(services.db, session.coordinatorId, eventId, templateId, services.now());
    if (!removed.ok) {
      if (removed.error === 'That weekly template is not available.') return missing(c, services);
      return showRemoveTemplate(c, services, removed.error, 400);
    }
    return c.redirect(appPath(services.config, `/admin/events/${eventId}?notice=template-removed`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveShifts(c: Context, services: AdminServices, error: string, status: 200 | 400 | 403 = 400) {
  return showEvent(
    c,
    services,
    undefined,
    status,
    {
      action: appPath(services.config, `/admin/events/${idFrom(c)}/shifts/remove`),
      title: 'Remove selected shifts',
      body: error,
    },
    idFrom(c),
  );
}

async function submitRemoveShifts(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  if (!getAdminEvent(services.db, eventId)) return missing(c, services);
  const shiftIds = idList(session.body, 'shift[]');
  if (!shiftIds) return showRemoveShifts(c, services, 'That shift is not available.');
  try {
    const removed = deleteFinishedShifts(services.db, session.coordinatorId, eventId, shiftIds, services.now());
    if (!removed.ok) return showRemoveShifts(c, services, removed.error);
    const notice = removed.count === 1 ? 'shift-removed' : 'shifts-removed';
    return c.redirect(appPath(services.config, `/admin/events/${eventId}?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveShift(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const shift = readShiftRemoval(services.db, idFrom(c), services.now());
  if (!shift) return missing(c, services);
  return showEvent(
    c,
    services,
    undefined,
    status,
    {
      ...shiftRemovalPrompt(shift, error),
      action: appPath(services.config, `/admin/shifts/${shift.id}/remove`),
    },
    shift.eventId,
  );
}

async function submitRemoveShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const shiftId = idFrom(c);
  try {
    const removed = deleteFinishedShift(services.db, session.coordinatorId, shiftId, services.now());
    if (!removed.ok) {
      if (removed.error === 'That shift is not available.') return missing(c, services);
      return showRemoveShift(c, services, removed.error, 400);
    }
    return c.redirect(appPath(services.config, `/admin/events/${removed.eventId}?notice=shift-removed`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveSignups(c: Context, services: AdminServices, error: string, status: 200 | 400 | 403 = 400) {
  return showShift(
    c,
    services,
    undefined,
    status,
    undefined,
    idFrom(c),
    {
      action: appPath(services.config, `/admin/shifts/${idFrom(c)}/signups/remove`),
      title: 'Remove selected people',
      body: error,
    },
  );
}

async function submitRemoveSignups(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const shiftId = idFrom(c);
  if (!getAdminShift(services.db, shiftId)) return missing(c, services);
  const signupIds = idList(session.body, 'signup[]');
  if (!signupIds) return showRemoveSignups(c, services, 'That signup is not available.');
  try {
    const removed = deleteCancelledSignups(services.db, session.coordinatorId, shiftId, signupIds, services.now());
    if (!removed.ok) return showRemoveSignups(c, services, removed.error);
    const notice = removed.count === 1 ? 'signup-removed' : 'signups-removed';
    return c.redirect(appPath(services.config, `/admin/shifts/${shiftId}?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showRemoveSignup(c: Context, services: AdminServices, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const signup = readSignupRemoval(services.db, idFrom(c));
  if (!signup) return missing(c, services);
  return showShift(
    c,
    services,
    undefined,
    status,
    undefined,
    signup.shiftId,
    {
      ...signupRemovalPrompt(signup, error),
      action: appPath(services.config, `/admin/signups/${signup.id}/remove`),
    },
  );
}

async function submitRemoveSignup(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const signupId = idFrom(c);
  try {
    const removed = deleteCancelledSignup(services.db, session.coordinatorId, signupId, services.now());
    if (!removed.ok) {
      if (removed.error === 'That signup is not available.') return missing(c, services);
      return showRemoveSignup(c, services, removed.error, 400);
    }
    return c.redirect(appPath(services.config, `/admin/shifts/${removed.shiftId}?notice=signup-removed`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showNewShift(c: Context, services: AdminServices, values?: ShiftValues, error?: string, status: 200 | 400 | 403 = 200) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const event = getAdminEvent(services.db, idFrom(c));
  if (!event) return missing(c, services);
  return html(
    c,
    services,
    'New shift · Hope Volunteer',
    <ShiftEditor
      config={services.config}
      heading={`New shift for ${event.title}`}
      action={appPath(services.config, `/admin/events/${event.id}/shifts`)}
      csrf={session.csrf}
      values={values ?? { role: '', date: '', start: '09:00', end: '12:00', capacity: '1' }}
      eventId={event.id}
      eventTitle={event.title}
      error={error}
      submitLabel="Create shift"
    />,
    { account: session, status },
  );
}

async function submitNewShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const eventId = idFrom(c);
  const values = shiftValuesFrom(session.body);
  const parsed = parseShift(values);
  if (!parsed.ok) return showNewShift(c, services, values, parsed.error, 400);
  try {
    const saved = createShift(services.db, session.coordinatorId, eventId, parsed.value, services.now());
    if (!saved.ok) return showNewShift(c, services, values, saved.error, 400);
    return c.redirect(appPath(services.config, `/admin/shifts/${saved.id}?notice=saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showShift(
  c: Context,
  services: AdminServices,
  error?: string,
  status: 200 | 400 | 403 = 200,
  walkIn?: WalkInState,
  shiftId = idFrom(c),
  confirm?: ConfirmPrompt,
  editError?: string,
) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const shift = getAdminShift(services.db, shiftId);
  if (!shift) return missing(c, services);
  const now = services.now();
  const ended = !shift.cancelled && shift.endsAtUtc <= now;
  const full = !ended && !shift.cancelled && shift.occupied >= shift.capacity;
  const showWalkIn = !shift.cancelled && !ended && !full;
  const walkInNote = ended ? 'This shift has ended.' : full ? 'This shift is full.' : undefined;
  const confirmed = shift.people.some((person) => person.status === 'confirmed');
  const targets = confirmed ? listMoveTargets(services.db, shift.eventId, shift.id, now) : [];
  const tokens: Record<number, string> = {};
  if (targets.length > 0) {
    for (const person of shift.people) {
      if (person.status !== 'confirmed') continue;
      tokens[person.id] = issueFormToken(services.config.sessionSecret, {
        shiftId: shift.id,
        issuedAt: Date.parse(now),
        operationId: newOperationId(),
      });
    }
  }
  return html(
    c,
    services,
    `${shift.role} · Hope Volunteer`,
    <ShiftRoster
      config={services.config}
      csrf={session.csrf}
      shift={shift}
      removable={shift.cancelled || shift.endsAtUtc <= now}
      notice={knownNotice(c.req.query('notice'))}
      error={error}
      walkIn={showWalkIn ? (walkIn ?? blankWalkIn(services, shift.id)) : undefined}
      walkInNote={walkInNote}
      contacts={showWalkIn ? loadContacts(services.db, '').people : []}
      moves={confirmed ? { targets, tokens } : undefined}
      confirm={confirm}
      editError={editError}
    />,
    { account: session, status },
  );
}

async function submitWalkIn(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  const shift = getAdminShift(services.db, id);
  if (!shift) return missing(c, services);
  const contactId = textField(session.body, 'contact').trim();
  const entered = signupValuesFrom(session.body);
  if (shift.cancelled || shift.endsAtUtc <= services.now()) return showShift(c, services, undefined, 400);
  if (shift.occupied >= shift.capacity) return showShift(c, services, undefined, 400);
  const token = readFormToken(services.config.sessionSecret, textField(session.body, 'form_token'), id, Date.parse(services.now()), 0);
  if (!token.ok) {
    return showShift(c, services, undefined, 400, blankWalkIn(services, id, entered, {}, 'This form is out of date. Submit it again.', contactId));
  }
  const filled = applySavedContact(services.db, contactId, entered);
  if (!filled.ok) {
    return showShift(c, services, undefined, 400, blankWalkIn(services, id, entered, {}, 'That saved contact is not available.', contactId));
  }
  const parsed = parseSignupForm(filled.values, 'coordinator');
  if (!parsed.ok) {
    return showShift(c, services, undefined, 400, {
      token: textField(session.body, 'form_token'),
      values: filled.values,
      errors: parsed.errors,
      contactId,
    });
  }
  try {
    const saved = addWalkIn(services.db, session.coordinatorId, {
      shiftId: id,
      name: parsed.draft.name,
      email: parsed.draft.emailNorm,
      phone: parsed.draft.phone,
      notes: parsed.draft.notes,
      groupSize: parsed.draft.groupSize,
      operationId: token.claims.operationId,
      now: services.now(),
      mail: mailIdentity(services.db, services.config),
    });
    if (saved.ok) return c.redirect(appPath(services.config, `/admin/shifts/${id}?notice=walk-in`), 303);
    if (saved.reason === 'not_found') return missing(c, services);
    if (saved.reason === 'closed') return showShift(c, services, undefined, 400);
    if (saved.reason === 'full') {
      const current = getAdminShift(services.db, id);
      const left = current ? current.capacity - current.occupied : 0;
      if (left > 0) {
        return showShift(c, services, undefined, 400, {
          token: textField(session.body, 'form_token'),
          values: filled.values,
          errors: { partySize: spotsLeftMessage(left) },
          contactId,
        });
      }
      return showShift(c, services, undefined, 400);
    }
    if (saved.reason === 'duplicate') {
      return showShift(c, services, undefined, 400, {
        token: textField(session.body, 'form_token'),
        values: filled.values,
        errors: { email: 'That person is already signed up for this shift.' },
        contactId,
      });
    }
    return showShift(
      c,
      services,
      undefined,
      400,
      blankWalkIn(services, id, filled.values, {}, 'This form was already used for a different signup. Submit it again.', contactId),
    );
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  const values = shiftValuesFrom(session.body);
  const parsed = parseShift(values);
  if (!parsed.ok) return showShift(c, services, undefined, 400, undefined, id, undefined, parsed.error);
  try {
    const saved = updateShift(services.db, session.coordinatorId, id, parsed.value, services.now(), mailIdentity(services.db, services.config));
    if (!saved.ok) return showShift(c, services, undefined, 400, undefined, id, undefined, saved.error);
    return c.redirect(appPath(services.config, `/admin/shifts/${id}?notice=saved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showCancelShift(c: Context, services: AdminServices) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const shift = getAdminShift(services.db, idFrom(c));
  if (!shift) return missing(c, services);
  const confirmed = shift.people.filter((person) => person.status === 'confirmed').length;
  return showShift(c, services, undefined, 200, undefined, shift.id, {
    ...shiftCancelPrompt({ role: shift.role, whenLabel: shift.whenLabel, cancelled: shift.cancelled, confirmed }),
    action: appPath(services.config, `/admin/shifts/${shift.id}/cancel`),
  });
}

function showCancelSignup(c: Context, services: AdminServices) {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  const signup = readSignupRemoval(services.db, idFrom(c));
  if (!signup) return missing(c, services);
  return showShift(c, services, undefined, 200, undefined, signup.shiftId, {
    ...signupCancelPrompt(signup),
    action: appPath(services.config, `/admin/signups/${signup.id}/cancel`),
  });
}

async function submitCancelShift(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  try {
    const result = cancelShift(services.db, session.coordinatorId, id, services.now(), mailIdentity(services.db, services.config));
    if (!result.ok) return missing(c, services);
    const notice = result.already || result.mailed === 0 ? 'shift-closed' : 'shift-cancelled';
    return c.redirect(appPath(services.config, `/admin/shifts/${id}?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitMove(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const signupId = idFrom(c);
  const shiftId = findSignupShift(services.db, signupId);
  if (shiftId === null) return missing(c, services);
  const token = readFormToken(services.config.sessionSecret, textField(session.body, 'move_token'), shiftId, Date.parse(services.now()), 0);
  if (!token.ok) return showShift(c, services, 'This form is out of date. Submit it again.', 400, undefined, shiftId);
  const destination = Number(textField(session.body, 'destination'));
  if (!Number.isSafeInteger(destination) || destination <= 0) {
    return showShift(c, services, 'Choose a shift.', 400, undefined, shiftId);
  }
  try {
    const result = moveSignup(
      services.db,
      session.coordinatorId,
      signupId,
      destination,
      token.claims.operationId,
      services.now(),
      mailIdentity(services.db, services.config),
    );
    if (!result.ok) {
      if (result.shiftId === undefined) return missing(c, services);
      return showShift(c, services, result.error, 400, undefined, result.shiftId);
    }
    return c.redirect(appPath(services.config, `/admin/shifts/${result.toShiftId}?notice=moved`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

async function submitCancelSignup(c: Context, services: AdminServices): Promise<Response> {
  const session = await postedSession(c, services);
  if (session instanceof Response) return session;
  const id = idFrom(c);
  try {
    const result = cancelSignupAsCoordinator(services.db, session.coordinatorId, id, services.now(), mailIdentity(services.db, services.config));
    if (!result.ok || result.shiftId === undefined) return missing(c, services);
    const notice = result.already ? 'already-cancelled' : 'signup-cancelled';
    return c.redirect(appPath(services.config, `/admin/shifts/${result.shiftId}?notice=${notice}`), 303);
  } catch (err) {
    return saveFailed(c, services, session, err);
  }
}

function showEventEditor(
  c: Context,
  services: AdminServices,
  session: PostedSession,
  id: number,
  values: EventValues,
  error: string,
) {
  const event = getAdminEvent(services.db, id);
  if (!event) return missing(c, services);
  return html(
    c,
    services,
    `${event.title} · Hope Volunteer`,
    <EventEditor
      config={services.config}
      heading={event.title}
      action={appPath(services.config, `/admin/events/${event.id}`)}
      csrf={session.csrf}
      values={values}
      event={event}
      error={error}
      now={services.now()}
      submitLabel="Save event"
    />,
    { account: session, status: 400 },
  );
}

type PostedSession = CoordinatorSession & { body: Record<string, unknown> };

async function postedSession(c: Context, services: AdminServices): Promise<PostedSession | Response> {
  const session = requireSession(c, services);
  if (session instanceof Response) return session;
  if (!originAllowed(c, services.config.baseUrl)) {
    return html(c, services, 'Coordinator · Hope Volunteer', <MessagePage heading="Coordinator" message={STALE} />, { status: 403, account: session });
  }
  const body = await c.req.parseBody();
  if (!csrfMatches(session.csrf, textField(body, 'csrf'))) {
    return html(c, services, 'Coordinator · Hope Volunteer', <MessagePage heading="Coordinator" message={STALE} />, { status: 403, account: session });
  }
  return { ...session, body };
}

function requireSession(c: Context, services: AdminServices): CoordinatorSession | Response {
  const session = readSession(services.db, c.req.header('cookie'), services.now());
  if (!session) return c.redirect(appPath(services.config, '/login'), 303);
  return session;
}

function rejectLink(c: Context, services: AdminServices, ip: string) {
  const limit = recordInvalidLoginToken(services.db, services.config.sessionSecret, services.now(), ip);
  if (limit.limited) {
    c.header('Retry-After', String(limit.retryAfter));
    return html(c, services, 'Sign in · Hope Volunteer', <MessagePage heading="Sign in" message={TOO_MANY} />, { status: 429 });
  }
  return html(c, services, 'Sign in · Hope Volunteer', <MessagePage heading="Sign in" message={LINK_UNAVAILABLE} />, { status: 404 });
}

function loginWait(c: Context, services: AdminServices, retryAfter: number) {
  c.header('Retry-After', String(retryAfter));
  return html(c, services, 'Coordinator sign-in · Hope Volunteer', <LoginPage config={services.config} error={TOO_MANY} />, { status: 429, turnstile: true });
}

function missing(c: Context, services: AdminServices) {
  return html(c, services, 'That page is not available · Hope Volunteer', <MessagePage heading="That page is not available" message="That page is not available." />, {
    status: 404,
  });
}

function saveFailed(c: Context, services: AdminServices, session: CoordinatorSession, err: unknown) {
  if (!isBusy(err)) throw err;
  console.error('Admin save could not lock the database.');
  return html(c, services, 'Coordinator · Hope Volunteer', <MessagePage heading="Coordinator" message={SAVE_BUSY} />, { status: 503, account: session });
}

function html(
  c: Context,
  services: AdminServices,
  title: string,
  body: Child,
  options?: { status?: 200 | 400 | 403 | 404 | 429 | 503; turnstile?: boolean; account?: CoordinatorSession | null },
) {
  c.header('Cache-Control', 'no-store');
  const account = options?.account === undefined ? readSession(services.db, c.req.header('cookie'), services.now()) : options.account;
  return c.html(
    <Layout config={services.config} title={title} path={c.req.path} turnstile={options?.turnstile} account={account ? { csrf: account.csrf } : null}>
      {body}
    </Layout>,
    options?.status ?? 200,
  );
}

async function checkTurnstile(services: AdminServices, token: string, remoteIp: string): Promise<TurnstileVerdict> {
  const verify = services.verifyTurnstile ?? verifyTurnstile;
  try {
    return await verify({
      secret: services.config.turnstile.secretKey,
      token,
      remoteIp,
      expectedHostname: new URL(services.config.baseUrl).hostname,
      expectedAction: 'login',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function mailIdentity(db: Database.Database, config: AppConfig): MailIdentity {
  return { baseUrl: config.baseUrl, basePath: config.basePath, from: config.mail.from, replyTo: readReplyTo(db, config.mail.replyTo) };
}

function blankTemplate(startsOn: string): TemplateValues {
  return { role: '', weekday: '', start: '09:00', end: '12:00', capacity: '6', startsOn, endsOn: '' };
}

function localToday(tz: string, now: string): string {
  return Temporal.Instant.from(now).toZonedDateTimeISO(tz).toPlainDate().toString();
}

function blankEvent(tz: string): EventValues {
  return { title: '', slug: '', description: '', location: '', tz, published: false };
}

function knownNotice(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (
    value === 'saved' ||
    value === 'signup-cancelled' ||
    value === 'already-cancelled' ||
    value === 'shift-cancelled' ||
    value === 'shift-closed' ||
    value === 'walk-in' ||
    value === 'moved' ||
    value === 'generated' ||
    value === 'no-template' ||
    value === 'template-saved' ||
    value === 'template-ended' ||
    value === 'signup-removed' ||
    value === 'signups-removed' ||
    value === 'shift-removed' ||
    value === 'shifts-removed' ||
    value === 'template-removed' ||
    value === 'event-removed' ||
    value === 'settings-saved' ||
    value === 'admin-added' ||
    value === 'admin-restored' ||
    value === 'admin-removed' ||
    value === 'contact-removed' ||
    value === 'contact-saved' ||
    value === 'contact-updated' ||
    value === 'contact-matched' ||
    value === 'contact-corrected' ||
    value === 'contact-same'
  ) {
    return value;
  }
  return undefined;
}

function blankWalkIn(
  services: AdminServices,
  shiftId: number,
  values: SignupValues = EMPTY_SIGNUP,
  errors: WalkInState['errors'] = {},
  message?: string,
  contactId = '',
): WalkInState {
  return {
    token: issueFormToken(services.config.sessionSecret, {
      shiftId,
      issuedAt: Date.parse(services.now()),
      operationId: newOperationId(),
    }),
    values,
    errors,
    message,
    contactId,
  };
}

function signupValuesFrom(body: Record<string, unknown>): SignupValues {
  return {
    name: textField(body, 'name'),
    firstName: '',
    lastName: '',
    email: textField(body, 'email'),
    phone: textField(body, 'phone'),
    notes: textField(body, 'notes'),
    partySize: textField(body, 'party_size'),
  };
}

function idFrom(c: Context): number {
  return paramId(c, 'id');
}

function wholeId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function templateIdFrom(c: Context): number {
  return paramId(c, 'templateId');
}

function paramId(c: Context, name: string): number {
  const value = c.req.param(name) ?? '';
  if (!/^[1-9][0-9]*$/.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function applySavedContact(
  db: Database.Database,
  contactId: string,
  values: SignupValues,
): { ok: true; values: SignupValues } | { ok: false } {
  if (contactId === '') return { ok: true, values };
  if (!/^[1-9][0-9]*$/.test(contactId)) return { ok: false };
  const id = Number(contactId);
  if (!Number.isSafeInteger(id)) return { ok: false };
  const contact = getContact(db, id);
  if (!contact) return { ok: false };
  return { ok: true, values: walkInFromContact(contact, values) };
}

function contactSummary(c: Context): ContactImportSummary | undefined {
  if (c.req.query('notice') !== 'contacts-imported') return undefined;
  const added = wholeNumber(c.req.query('added'));
  const changed = wholeNumber(c.req.query('changed'));
  const unchanged = wholeNumber(c.req.query('unchanged'));
  const skipped = wholeNumber(c.req.query('skipped'));
  if (added === null || changed === null || unchanged === null || skipped === null) return undefined;
  return { added, changed, unchanged, skipped, skips: parseContactSkips(c.req.query('skip')) };
}

function wholeNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return 0;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function importLocation(config: AppConfig, result: ContactImportSummary): string {
  const params = new URLSearchParams({
    notice: 'contacts-imported',
    added: String(result.added),
    changed: String(result.changed),
    unchanged: String(result.unchanged),
    skipped: String(result.skipped),
  });
  const skip = formatContactSkips(result.skips);
  if (skip) params.set('skip', skip);
  return appPath(config, `/admin/contacts?${params.toString()}`);
}

async function csvFromField(value: unknown): Promise<string | null> {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return csvFromField(value[0]);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.text();
  return null;
}

function idList(body: Record<string, unknown>, name: string): number[] | null {
  const value = body[name];
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!raw) return null;
  const ids: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !/^[1-9][0-9]*$/.test(item)) return null;
    const id = Number(item);
    if (!Number.isSafeInteger(id)) return null;
    ids.push(id);
  }
  return ids;
}

function peerAddress(c: Context, override: AdminServices['clientIp']): string | null {
  if (override) return override(c);
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}
