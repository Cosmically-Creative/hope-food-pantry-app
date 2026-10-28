import { Temporal } from '@js-temporal/polyfill';
import { DESK_WINDOW_DAYS, type AdminEvent, type HomeEvent, type HomeShift, type AdminShift, type AdminShiftSummary, type AdminTemplate, type MoveTarget, type RosterPerson } from './admin/store.js';
import { spotsSentence } from './schedule.js';
import type { EventValues, ShiftValues, TemplateValues } from './admin/forms.js';
import type { SettingsErrors, SettingsForm } from './settings.js';
import type { AppConfig } from './config.js';
import {
  CONTACT_LIST_PAGE,
  contactImportSentence,
  contactSkipSentence,
  type Contact,
  type ContactImportSummary,
  type ContactManualErrors,
  type ContactManualValues,
  type ContactShift,
} from './contacts.js';
import type { SignupErrors, SignupValues } from './signup-form.js';
import { PartySizeField } from './pages.js';
import { addLocalDays, formatInstantInZone, todayInZone } from './time.js';
import { ShiftTargetOptions } from './shift-options.js';
import type { AdminAccount, AdminErrors, AdminForm } from './admins.js';
import { assetHref } from './static-assets.js';
import { appPath } from './url.js';

export type WalkInState = {
  token: string;
  values: SignupValues;
  errors: SignupErrors;
  message?: string;
  contactId?: string;
};

export type ConfirmPrompt = {
  action: string;
  title: string;
  body: string;
  detail?: string;
  note?: string;
  submit?: string;
  error?: string;
};

const SHIFT_DELETE_BODY = 'This deletes the shift. It does not send email.';
const SHIFT_PEOPLE_BODY = 'Remove everyone on this roster first.';
const SHIFT_WAIT_BODY = 'Cancel this shift, or wait until it has ended, before removing it.';
const SHIFT_WEEKLY_NOTE =
  'This date came from a weekly template that is still active. Add weekly shifts can put this date back. End that template first if the date should stay gone.';
const PERSON_DELETE_BODY = 'This deletes their name, email, phone, and notes from the roster. It does not send email.';
const PERSON_WAIT_BODY = 'Cancel this signup before removing it.';
const PERSON_CANCEL_BODY = 'Cancelling a signup emails them. Their old private link stops working, and the email includes a new one.';
const SHIFT_CANCEL_EMPTY = 'No one is signed up. Cancelling closes the shift and does not send email.';
const SHIFT_CANCEL_STAY = 'The roster stays. After it is empty, the shift can be removed.';
const SHIFT_ALREADY = 'This shift is already cancelled.';
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const TEMPLATE_END_BODY = 'Ending it stops later weeks from being added. Shifts already on the schedule stay.';
const TEMPLATE_ENDED_BODY = 'This weekly template has ended. Shifts already on the schedule stay.';
const TEMPLATE_DELETE_BODY =
  'This deletes the weekly template. Shifts already on the schedule stay. They are no longer tied to this weekly pattern, so later weekly fills will not change them.';
const TEMPLATE_WAIT_BODY = 'End this template before removing it.';

export function shiftRemovalPrompt(
  shift: { role: string; whenLabel?: string; signupCount: number; weeklyActive: boolean; cancelled: boolean; ended: boolean },
  error?: string,
): Omit<ConfirmPrompt, 'action'> {
  const people = error === SHIFT_PEOPLE_BODY || (error !== SHIFT_WAIT_BODY && shift.signupCount > 0);
  const waiting = !people && (error === SHIFT_WAIT_BODY || (!shift.cancelled && !shift.ended));
  const body = people ? SHIFT_PEOPLE_BODY : waiting ? SHIFT_WAIT_BODY : SHIFT_DELETE_BODY;
  return {
    title: `Remove ${shift.role}`,
    detail: shift.whenLabel?.replace(/, (\d{1,2}:\d{2})/, '\n$1'),
    body,
    note: people || waiting || !shift.weeklyActive ? undefined : SHIFT_WEEKLY_NOTE,
    submit: people || waiting ? undefined : 'Remove this shift',
    error: error && error !== body ? error : undefined,
  };
}

export function signupRemovalPrompt(signup: { name: string | null; status: string }, error?: string): Omit<ConfirmPrompt, 'action'> {
  const blocked = error === PERSON_WAIT_BODY || signup.status !== 'cancelled';
  const body = blocked ? PERSON_WAIT_BODY : PERSON_DELETE_BODY;
  return {
    title: `Remove ${signup.name ?? 'This roster record'}`,
    body,
    submit: blocked ? undefined : 'Remove this person',
    error: error && error !== body ? error : undefined,
  };
}

export function signupCancelPrompt(signup: { name: string | null; status: string }): Omit<ConfirmPrompt, 'action'> {
  if (signup.status === 'cancelled') {
    return { title: `Cancel ${signup.name ?? 'this signup'}`, body: 'That signup was already cancelled.' };
  }
  return {
    title: `Cancel ${signup.name ?? 'this signup'}`,
    body: PERSON_CANCEL_BODY,
    submit: 'Cancel signup',
  };
}

export function shiftCancelPrompt(shift: { role: string; whenLabel?: string; cancelled: boolean; confirmed: number }): Omit<ConfirmPrompt, 'action'> {
  if (shift.cancelled) {
    return { title: `Cancel ${shift.role}`, detail: whenDetail(shift.whenLabel), body: SHIFT_ALREADY };
  }
  const confirmed = shift.confirmed;
  return {
    title: `Cancel ${shift.role}`,
    detail: whenDetail(shift.whenLabel),
    body:
      confirmed === 0
        ? SHIFT_CANCEL_EMPTY
        : `This closes the shift. ${confirmed} confirmed ${confirmed === 1 ? 'signup' : 'signups'} will be marked cancelled, and a cancellation email is queued for each.`,
    note: SHIFT_CANCEL_STAY,
    submit: 'Cancel this shift',
  };
}

export function eventRemovalPrompt(
  event: { title: string; published: boolean; shiftCount: number; templateCount: number; signupCount: number },
  error?: string,
): Omit<ConfirmPrompt, 'action'> {
  const expected = eventDeleteBody(event);
  return {
    title: `Remove ${event.title}`,
    body: error && error !== expected ? error : expected,
    note: event.published ? 'This event is on the public list. Removing it takes that listing away.' : undefined,
    submit: error ? undefined : 'Remove this event',
  };
}

export function templateEndPrompt(template: { role: string; weekday: number; active: boolean }): Omit<ConfirmPrompt, 'action'> {
  const title = `End ${weekdayName(template.weekday)} ${template.role}`;
  if (!template.active) return { title, body: TEMPLATE_ENDED_BODY };
  return { title, body: TEMPLATE_END_BODY, submit: 'End this template' };
}

export function contactRemovalPrompt(contact: { name: string; email: string }): Omit<ConfirmPrompt, 'action'> {
  return {
    title: `Remove ${contact.name}`,
    detail: contact.email,
    body: 'This deletes their name, email, and phone from the contact list. It does not cancel a signup and it does not send email.',
    submit: 'Remove this contact',
  };
}

export function adminRemovalPrompt(admin: { name: string; email: string; self: boolean; last: boolean }): Omit<ConfirmPrompt, 'action'> {
  const title = admin.self ? 'Remove your access' : `Remove ${admin.name}`;
  if (admin.last) {
    return { title, detail: admin.email, body: 'Add another administrator before removing this one.' };
  }
  if (admin.self) {
    return {
      title,
      detail: admin.email,
      body: 'This signs you out. Your sign-in links stop working. Someone else who still has access can add you again. It does not send email.',
      submit: 'Remove your access',
    };
  }
  return {
    title,
    detail: admin.email,
    body: 'This removes their access. Their sign-in links stop working. It does not send email.',
    submit: 'Remove this administrator',
  };
}

export function templateRemovalPrompt(
  template: { role: string; weekday: number; active: boolean },
  error?: string,
): Omit<ConfirmPrompt, 'action'> {
  const title = `Remove ${weekdayName(template.weekday)} ${template.role}`;
  const blocked = template.active || error === TEMPLATE_WAIT_BODY;
  const body = blocked ? TEMPLATE_WAIT_BODY : TEMPLATE_DELETE_BODY;
  return {
    title,
    body,
    submit: blocked ? undefined : 'Remove this template',
    error: error && error !== body ? error : undefined,
  };
}

function whenDetail(whenLabel?: string): string | undefined {
  return whenLabel?.replace(/, (\d{1,2}:\d{2})/, '\n$1');
}

function Crumb(props: { items: { href?: string; label: string }[] }) {
  return (
    <nav class="crumb" aria-label="Breadcrumb">
      {props.items.map((item, index) => (
        <span class="crumb-part" key={`${index}-${item.label}`}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          {item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function AdminHome(props: {
  config: AppConfig;
  name: string;
  events: HomeEvent[];
  shifts: HomeShift[];
  now: string;
  csrf: string;
  notice?: string;
  exportFrom?: string;
  exportTo?: string;
  exportError?: string;
  backupNote: string;
  backupState: 'saved' | 'waiting' | 'behind';
  backupSavedToday: boolean;
  newEvent?: { values: EventValues; error?: string };
}) {
  const draft = props.newEvent?.values ?? {
    title: '',
    slug: '',
    description: '',
    location: '',
    tz: props.config.defaultTimeZone,
    published: false,
  };
  const clock = formatInstantInZone(props.now, props.config.defaultTimeZone);
  const thisMonth = monthBounds(clock.date, 0);
  const lastMonth = monthBounds(clock.date, -1);
  const exportFrom = props.exportFrom || thisMonth.from;
  const exportTo = props.exportTo || thisMonth.to;
  const preset =
    exportFrom === thisMonth.from && exportTo === thisMonth.to
      ? 'this'
      : exportFrom === lastMonth.from && exportTo === lastMonth.to
        ? 'last'
        : 'custom';
  const openShifts = props.shifts.filter((shift) => !shift.full);
  const fullShifts = props.shifts.filter((shift) => shift.full);
  return (
    <>
      <header class="desk-intro desk-home-intro">
        <div class="desk-home-copy">
          <h1>Coordinator</h1>
          <p class="desk-date">{clock.dateLabel}</p>
          <p class="desk-signed">
            Signed in as <strong>{props.name}</strong>.
          </p>
        </div>
        <div class="desk-intro-side">
          <p class={props.backupSavedToday ? 'desk-note is-saved' : 'desk-note'}>
            {props.backupSavedToday ? <BackupSavedToday /> : <BackupNote text={props.backupNote} />}
          </p>
          <nav class="desk-links" aria-label="Coordinator">
            <a href={appPath(props.config, '/admin/contacts')}>Contacts</a>
            <a href={appPath(props.config, '/admin/settings')}>Settings</a>
            <a href={appPath(props.config, '/admin/admins')}>Administrators</a>
          </nav>
        </div>
      </header>
      <Notice notice={props.notice} />
      <div class="coordinator-board">
        <section class="desk-panel" aria-labelledby="needs-heading">
          <div class="desk-panel-head">
            <h2 id="needs-heading">Shifts that need volunteers</h2>
            <p class="desk-panel-aside">Next 2 weeks</p>
          </div>
          {openShifts.length === 0 ? <p class="empty">No open shifts in the next 2 weeks.</p> : <ShiftNeedList config={props.config} shifts={openShifts} today={clock.date} />}
          {fullShifts.length > 0 ? <FullShiftNotes shifts={fullShifts} /> : null}
        </section>
        <div class="desk-split">
          <section class="desk-panel" aria-labelledby="events-heading">
            <div class="desk-panel-head">
              <h2 id="events-heading">Events</h2>
              <a class="btn" href={appPath(props.config, '/admin/events/new')} data-open-event>
                New event
              </a>
            </div>
            {props.events.length === 0 ? <p class="empty">No events yet.</p> : <EventList config={props.config} events={props.events} today={clock.date} />}
          </section>
          <form method="post" action={appPath(props.config, '/admin/export')} class="signup-form desk-panel desk-download" data-export-range>
            <input type="hidden" name="csrf" value={props.csrf} />
            <h2>Download signups</h2>
            <p class="desk-download-copy">A spreadsheet of everyone signed up for shifts in these dates.</p>
            {props.exportError ? <p class="error">{props.exportError}</p> : null}
            <div class="range-presets" role="group" aria-label="Date range">
              <button type="button" data-range="this" data-from={thisMonth.from} data-to={thisMonth.to} aria-pressed={preset === 'this' ? 'true' : 'false'}>
                This month
              </button>
              <button type="button" data-range="last" data-from={lastMonth.from} data-to={lastMonth.to} aria-pressed={preset === 'last' ? 'true' : 'false'}>
                Last month
              </button>
              <button type="button" data-range="custom" aria-pressed={preset === 'custom' ? 'true' : 'false'}>
                Custom
              </button>
            </div>
            <div class="desk-fields">
              <label>
                From
                <input name="from" type="date" required value={exportFrom} />
              </label>
              <label>
                To
                <input name="to" type="date" required value={exportTo} />
              </label>
            </div>
            <button type="submit">Download spreadsheet</button>
          </form>
        </div>
      </div>
      <dialog id="new-event" class="event-dialog" aria-labelledby="new-event-title" open={props.newEvent ? true : undefined}>
        <div class="event-dialog-card">
          <EventForm
            action={appPath(props.config, '/admin/events')}
            csrf={props.csrf}
            values={draft}
            error={props.newEvent?.error}
            submitLabel="Create event"
            creating
            heading="New event"
            headingId="new-event-title"
          />
          <form method="dialog" class="event-dialog-dismiss">
            <button type="submit" class="event-dialog-close" aria-label="Close">
              <img src={assetHref(props.config, '/img/icons/close.svg')} alt="" />
            </button>
          </form>
        </div>
      </dialog>
      <script src={assetHref(props.config, '/js/event-dialog.js')} defer />
      <script src={assetHref(props.config, '/js/export-range.js')} defer />
    </>
  );
}

export function SettingsPage(props: {
  config: AppConfig;
  csrf: string;
  values: SettingsForm;
  errors?: SettingsErrors;
  notice?: string;
}) {
  const errors = props.errors ?? {};
  return (
    <>
      <Crumb items={[{ href: appPath(props.config, '/admin'), label: 'Coordinator' }, { label: 'Settings' }]} />
      <h1>Settings</h1>
      <Notice notice={props.notice} />
      <form method="post" action={appPath(props.config, '/admin/settings')} class="signup-form">
        <input type="hidden" name="csrf" value={props.csrf} />
        <p>These apply to reminders and mail that have not been queued yet. Mail that was already accepted cannot be recalled.</p>
        <label>
          First reminder, hours before the shift
          <input name="reminder_far" type="number" min="1" max="336" required value={props.values.reminderFar} />
          <span class="hint">The default is 48. Use a whole number from 1 to 336.</span>
          {errors.reminderFar ? <span class="error">{errors.reminderFar}</span> : null}
        </label>
        <label>
          Second reminder, hours before the shift
          <input name="reminder_near" type="number" min="1" max="336" required value={props.values.reminderNear} />
          <span class="hint">The default is 2. The two times have to be different. A reminder is not sent after the shift starts.</span>
          {errors.reminderNear ? <span class="error">{errors.reminderNear}</span> : null}
        </label>
        <label>
          Reply-to address
          <input name="reply_to" type="email" required value={props.values.replyTo} />
          <span class="hint">Replies to volunteer and sign-in email go here. The sending address stays in the server configuration.</span>
          {errors.replyTo ? <span class="error">{errors.replyTo}</span> : null}
        </label>
        <label>
          Keep signups for, months
          <input name="retention_months" type="number" min="1" max="120" required value={props.values.retentionMonths} />
          <span class="hint">The default is 24, counted after the shift ends. After 1:00 AM Central Time, signups older than this lose their name, email, phone, and notes in this app. A spreadsheet already downloaded is left as it is.</span>
          {errors.retentionMonths ? <span class="error">{errors.retentionMonths}</span> : null}
        </label>
        <label>
          Privacy page wording
          <textarea name="privacy_text">{props.values.privacyText}</textarea>
          <span class="hint">Leave this blank until the pantry approves a notice. Saved wording is what the public privacy page shows. Saving it does not by itself make it an approved privacy policy. Start a new line for a new paragraph.</span>
          {errors.privacyText ? <span class="error">{errors.privacyText}</span> : null}
        </label>
        <button type="submit">Save settings</button>
      </form>
    </>
  );
}

export function AdminsPage(props: {
  config: AppConfig;
  csrf: string;
  currentId: number;
  admins: AdminAccount[];
  notice?: string;
  form?: { values: AdminForm; errors: AdminErrors };
  confirm?: ConfirmPrompt;
}) {
  const form = props.form ?? { values: { name: '', email: '' }, errors: {} };
  const only = props.admins.length === 1;
  return (
    <>
      <Crumb items={[{ href: appPath(props.config, '/admin'), label: 'Coordinator' }, { label: 'Administrators' }]} />
      <h1>Administrators</h1>
      <Notice notice={props.notice} />
      <p>
        These people can sign in and manage the pantry. Adding someone does not send email. They request a sign-in link on the coordinator sign-in page. Removing someone signs them out and stops unused sign-in links. The last administrator stays until another one is added. Saving an address you removed earlier gives that person access again.
      </p>
      <form method="post" action={appPath(props.config, '/admin/admins')} class="signup-form">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Add an administrator</h2>
        <WalkInField id="admin-name" label="Name" name="name" type="text" value={form.values.name} error={form.errors.name} required />
        <WalkInField
          id="admin-email"
          label="Email"
          name="email"
          type="email"
          value={form.values.email}
          error={form.errors.email}
          hint="This is the address they use to request a sign-in link."
          required
        />
        <button type="submit">Add this administrator</button>
      </form>
      <section class="desk-events" aria-labelledby="admins-heading">
        <h2 id="admins-heading">{props.admins.length === 1 ? '1 administrator' : `${props.admins.length} administrators`}</h2>
        {only ? <p class="panel-note">This is the only administrator. Add another one before removing anyone.</p> : null}
        {props.admins.length === 0 ? <p class="empty">No administrators yet.</p> : null}
        {props.admins.length > 0 ? (
          <ul class="admin-list">
            {props.admins.map((person) => {
              const self = person.id === props.currentId;
              return (
                <li class="admin-row" key={person.id}>
                  <p>
                    <strong>{person.name}</strong>
                    {self ? <span class="admin-you">You</span> : null}
                  </p>
                  <p>{person.email}</p>
                  {only ? null : (
                    <p>
                      <ConfirmAnchor
                        href={appPath(props.config, `/admin/admins/${person.id}/remove`)}
                        label={self ? 'Remove your access' : `Remove ${person.name}`}
                        prompt={adminRemovalPrompt({ name: person.name, email: person.email, self, last: false })}
                      >
                        Remove
                      </ConfirmAnchor>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <ConfirmDialog config={props.config} csrf={props.csrf} prompt={props.confirm} />
    </>
  );
}

function contactListHref(config: AppConfig, query: string, shown: number): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('shown', String(shown));
  return `${appPath(config, '/admin/contacts')}?${params.toString()}#contact-more`;
}

function ContactShiftList(props: { config: AppConfig; shifts: ContactShift[]; empty: string }) {
  if (props.shifts.length === 0) return <p class="empty">{props.empty}</p>;
  return (
    <ul class="contact-shift-list">
      {props.shifts.map((shift) => (
        <li key={shift.signupId}>
          <a href={appPath(props.config, `/admin/shifts/${shift.shiftId}`)}>{shift.label}</a>
        </li>
      ))}
    </ul>
  );
}

export function ContactsPage(props: {
  config: AppConfig;
  csrf: string;
  people: Contact[];
  total: number;
  query: string;
  limit: number;
  notice?: string;
  summary?: ContactImportSummary;
  importError?: string;
  manual?: { values: ContactManualValues; errors: ContactManualErrors };
  confirm?: ConfirmPrompt;
}) {
  const manual = props.manual ?? { values: { firstName: '', lastName: '', email: '', phone: '' }, errors: {} };
  const heading =
    props.total === 0
      ? 'Saved contacts'
      : props.query
        ? `${props.people.length} of ${props.total}`
        : props.total === 1
          ? '1 person'
          : `${props.total} people`;
  const hiddenSkips = props.summary ? Math.max(0, props.summary.skipped - props.summary.skips.length) : 0;
  const moreHref = contactListHref(props.config, props.query, props.limit + CONTACT_LIST_PAGE);
  const addOpen = Object.keys(manual.errors).length > 0;
  const importOpen = Boolean(props.importError);
  return (
    <>
      <Crumb items={[{ href: appPath(props.config, '/admin'), label: 'Coordinator' }, { label: 'Contacts' }]} />
      <h1>Contacts</h1>
      {props.summary ? <Notice text={contactImportSentence(props.summary)} /> : <Notice notice={props.notice} />}
      {props.summary && props.summary.skips.length > 0 ? (
        <ul>
          {props.summary.skips.map((skip) => (
            <li key={skip.line}>{contactSkipSentence(skip)}</li>
          ))}
        </ul>
      ) : null}
      {hiddenSkips > 0 ? <p class="panel-note">{hiddenSkips === 1 ? '1 more row was skipped.' : `${hiddenSkips} more rows were skipped.`}</p> : null}
      <section class="desk-events" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading">{heading}</h2>
        <div class="contact-toolbar">
        {props.total > 0 ? (
          <form method="get" action={appPath(props.config, '/admin/contacts')} class="signup-form desk-download contact-find">
            <div class="desk-range">
              <label>
                Find
                <input name="q" type="search" value={props.query} />
              </label>
              <button type="submit">Find</button>
            </div>
          </form>
        ) : (
          <p class="empty">No contacts yet.</p>
        )}
        <div class="contact-actions">
        <details class="contact-menu" name="contact-tools" open={addOpen ? true : undefined}>
          <summary>
            Add a contact
            <span class="edit-chevron" aria-hidden="true" />
          </summary>
          <form method="post" action={appPath(props.config, '/admin/contacts/new')} class="signup-form">
            <input type="hidden" name="csrf" value={props.csrf} />
            <p>This saves one person. It does not sign them up and does not send email. The same name and email updates that person. A different name is saved separately, even with the same email. Names are capitalized. A 10-digit phone is saved with dashes, like 712-555-0100.</p>
            <WalkInField id="contact-first" label="First name" name="first_name" type="text" value={manual.values.firstName} error={manual.errors.firstName} />
            <WalkInField id="contact-last" label="Last name" name="last_name" type="text" value={manual.values.lastName} error={manual.errors.lastName} />
            <WalkInField id="contact-email" label="Email" name="email" type="email" value={manual.values.email} error={manual.errors.email} />
            <WalkInField id="contact-phone" label="Phone" name="phone" type="tel" value={manual.values.phone} error={manual.errors.phone} required />
            <button type="submit">Save this contact</button>
          </form>
        </details>
        <details class="contact-menu" name="contact-tools" open={importOpen ? true : undefined}>
          <summary>
            Import
            <span class="edit-chevron" aria-hidden="true" />
          </summary>
          <form method="post" action={appPath(props.config, '/admin/contacts/import')} class="signup-form" enctype="multipart/form-data">
            <input type="hidden" name="csrf" value={props.csrf} />
            <p>
              Use a spreadsheet with First Name, Last Name, Email, and Phone. The SignUpGenius people export works. Address is ignored. The same name and email updates that person. A different name stays a separate person, even when the email matches. A different email stays a separate person, even when the name matches. A row without a phone is skipped. Names are capitalized. A 10-digit phone is saved with dashes, like 712-555-0100. Email addresses are stored in lowercase. The file has to be under 64 KB.
            </p>
            {props.importError ? <p class="error">{props.importError}</p> : null}
            <label>
              Spreadsheet
              <input name="file" type="file" accept=".csv,text/csv,text/plain" required />
            </label>
            <button type="submit">Import this list</button>
          </form>
        </details>
        <details class="contact-menu" name="contact-tools">
          <summary>
            Download
            <span class="edit-chevron" aria-hidden="true" />
          </summary>
          <form method="post" action={appPath(props.config, '/admin/contacts/export')} class="signup-form">
            <input type="hidden" name="csrf" value={props.csrf} />
            <p>A downloaded copy stays on your computer. This app does not delete it later. The Address column is blank. A cell that would be a spreadsheet formula is saved as text.</p>
            <button type="submit">Download contacts</button>
          </form>
        </details>
        </div>
        </div>
        {props.total > 0 && props.people.length === 0 ? <p class="empty">No contacts match.</p> : null}
        {props.people.length > 0 ? (
          <ul class="contact-list" id="contacts-list">
            {props.people.map((person, index) => (
              <li class="contact-row" data-contact-row="1" hidden={index >= props.limit ? true : undefined} key={person.id}>
                <p class="contact-name">
                  <strong>
                    <a href={appPath(props.config, `/admin/contacts/${person.id}`)}>{person.name}</a>
                  </strong>
                </p>
                <p class="contact-email">{person.email}</p>
                <p class="contact-phone">{person.phone ?? ''}</p>
                <p class="contact-remove">
                  <ConfirmAnchor href={appPath(props.config, `/admin/contacts/${person.id}/remove`)} prompt={contactRemovalPrompt(person)}>
                    Remove
                  </ConfirmAnchor>
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {props.people.length > props.limit ? (
          <p class="contact-more" id="contact-more">
            <a class="btn btn-quiet" href={moreHref} data-see-more={String(CONTACT_LIST_PAGE)}>
              See more
            </a>
          </p>
        ) : null}
      </section>
      <ConfirmDialog config={props.config} csrf={props.csrf} prompt={props.confirm} />
    </>
  );
}

export function ContactPage(props: {
  config: AppConfig;
  csrf: string;
  contact: Contact;
  signedUp: { current: ContactShift[]; past: ContactShift[] };
  shifts: MoveTarget[];
  form: WalkInState;
  shiftId: string;
  notice?: string;
  correction?: { values: ContactManualValues; errors: ContactManualErrors };
  error?: string;
}) {
  const values = props.form.values;
  const errors = props.form.errors;
  const errorEntries = Object.entries(errors).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const correction = props.correction ?? {
    values: {
      firstName: props.contact.firstName,
      lastName: props.contact.lastName,
      email: props.contact.email,
      phone: props.contact.phone ?? '',
    },
    errors: {},
  };
  const editOpen = Object.keys(correction.errors).length > 0;
  const addOpen = Boolean(props.error || props.form.message || errorEntries.length > 0 || props.shiftId);
  return (
    <>
      <Crumb
        items={[
          { href: appPath(props.config, '/admin'), label: 'Coordinator' },
          { href: appPath(props.config, '/admin/contacts'), label: 'Contacts' },
          { label: props.contact.name },
        ]}
      />
      <h1>{props.contact.name}</h1>
      <p>{props.contact.email}</p>
      {props.contact.phone ? <p>{props.contact.phone}</p> : null}
      <Notice notice={props.notice} />
      <h2>Signed up for</h2>
      <ContactShiftList config={props.config} shifts={props.signedUp.current} empty="Not signed up for a shift." />
      <h2>Past shifts</h2>
      <ContactShiftList config={props.config} shifts={props.signedUp.past} empty="No past shifts." />
      <div class="contact-actions">
      <details class="contact-menu" name="contact-action" open={editOpen ? true : undefined}>
        <summary>
          Edit contact
          <span class="edit-chevron" aria-hidden="true" />
        </summary>
        <form method="post" action={appPath(props.config, `/admin/contacts/${props.contact.id}`)} class="signup-form">
          <input type="hidden" name="csrf" value={props.csrf} />
          <p>This changes the saved person. It does not change a signup, take a spot, or send email.</p>
          <WalkInField id="correct-first" label="First name" name="first_name" type="text" value={correction.values.firstName} error={correction.errors.firstName} />
          <WalkInField id="correct-last" label="Last name" name="last_name" type="text" value={correction.values.lastName} error={correction.errors.lastName} />
          <WalkInField id="correct-email" label="Email" name="email" type="email" value={correction.values.email} error={correction.errors.email} />
          <WalkInField
            id="correct-phone"
            label="Phone"
            name="phone"
            type="tel"
            value={correction.values.phone}
            error={correction.errors.phone}
            required
          />
          <button type="submit">Save contact</button>
        </form>
      </details>
      <details class="contact-menu" name="contact-action" open={addOpen ? true : undefined}>
        <summary>
          Add to a shift
          <span class="edit-chevron" aria-hidden="true" />
        </summary>
        {props.error ? <p class="error">{props.error}</p> : null}
        {props.shifts.length > 0 ? (
          <form method="post" action={appPath(props.config, `/admin/contacts/${props.contact.id}/add`)} class="signup-form">
            <p>This uses their saved name, email, and phone. It takes one spot and queues a confirmation email.</p>
            {props.form.message ? <p class="error">{props.form.message}</p> : null}
            {errorEntries.length > 0 ? (
              <div class="error" role="alert">
                <p>Check these fields:</p>
                <ul>
                  {errorEntries.map(([field, message]) => (
                    <li key={field}>{message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <input type="hidden" name="csrf" value={props.csrf} />
            <input type="hidden" name="form_token" value={props.form.token} />
            <label for="add-shift">
              Shift
              <select id="add-shift" name="shift" required>
                <ShiftTargetOptions targets={props.shifts} selectedId={props.shiftId} />
              </select>
            </label>
            <label for="add-notes">
              Notes (optional)
              <textarea id="add-notes" name="notes" aria-invalid={errors.notes ? 'true' : undefined}>
                {values.notes}
              </textarea>
              {errors.notes ? <span class="field-error">{errors.notes}</span> : null}
            </label>
            <button type="submit">Add to this shift</button>
          </form>
        ) : (
          <p class="empty">No open shift is available.</p>
        )}
      </details>
      </div>
    </>
  );
}

export function EventEditor(props: {
  config: AppConfig;
  heading: string;
  action: string;
  csrf: string;
  values: EventValues;
  event?: AdminEvent;
  error?: string;
  notice?: string;
  generateNote?: string;
  now?: string;
  submitLabel: string;
  confirm?: ConfirmPrompt;
}) {
  const event = props.event;
  const removal = event
    ? eventRemovalPrompt({
        title: event.title,
        published: event.published,
        shiftCount: event.shifts.length,
        templateCount: event.templates.length,
        signupCount: event.shifts.reduce((sum, shift) => sum + shift.signupCount, 0),
      })
    : undefined;
  return (
    <div class="event-page">
      {event ? (
        <header class="event-head">
          <Crumb items={[{ href: appPath(props.config, '/admin'), label: 'Coordinator' }, { label: props.heading }]} />
          <div class="event-titlebar">
            <div class="event-title">
              <h1>{props.heading}</h1>
              <span class={event.published ? 'event-badge is-public' : 'event-badge is-hidden'}>{event.published ? 'Public' : 'Hidden'}</span>
            </div>
            <div class="event-actions">
              {event.published ? (
                <a class="btn btn-line" href={appPath(props.config, `/e/${encodeURIComponent(event.slug)}`)}>
                  View public page
                </a>
              ) : null}
              <form method="post" action={appPath(props.config, `/admin/events/${event.id}/export`)}>
                <input type="hidden" name="csrf" value={props.csrf} />
                <button type="submit" class="btn btn-line">
                  Download spreadsheet
                </button>
              </form>
            </div>
          </div>
        </header>
      ) : (
        <header class="event-head">
          <h1>{props.heading}</h1>
        </header>
      )}
      <Notice notice={props.notice} />
      {event && removal ? (
        <section class="event-strip" aria-label="Event details">
          <p class="event-strip-line">
            <strong>Event details</strong>
            <span>{event.location.trim() || 'No address yet'}</span>
          </p>
          <details class="event-edit" open={props.error ? true : undefined}>
            <summary>
              Edit details
              <span class="edit-chevron" aria-hidden="true" />
            </summary>
            <EventForm action={props.action} csrf={props.csrf} values={props.values} error={props.error} submitLabel={props.submitLabel} wide />
          </details>
        </section>
      ) : (
        <EventForm action={props.action} csrf={props.csrf} values={props.values} error={props.error} submitLabel={props.submitLabel} wide />
      )}
      {event ? <ShiftList config={props.config} event={event} csrf={props.csrf} generateNote={props.generateNote} now={props.now} /> : null}
      {event && removal ? (
        <section class="event-danger" aria-labelledby="remove-event-heading">
          <div>
            <h2 id="remove-event-heading">Remove this event</h2>
            <p>You'll see what affects and confirm before anything is removed.</p>
          </div>
          <ConfirmAnchor class="btn btn-danger" href={appPath(props.config, `/admin/events/${event.id}/remove`)} prompt={removal}>
            Remove event...
          </ConfirmAnchor>
        </section>
      ) : null}
      {event ? <ConfirmDialog config={props.config} csrf={props.csrf} prompt={props.confirm} /> : null}
    </div>
  );
}

export function TemplateEditor(props: {
  config: AppConfig;
  heading: string;
  action: string;
  csrf: string;
  values: TemplateValues;
  eventId: number;
  eventTitle: string;
  ended?: boolean;
  error?: string;
  submitLabel: string;
}) {
  return (
    <>
      <Crumb
        items={[
          { href: appPath(props.config, '/admin'), label: 'Coordinator' },
          { href: appPath(props.config, `/admin/events/${props.eventId}`), label: props.eventTitle },
          { label: props.heading },
        ]}
      />
      <h1>{props.heading}</h1>
      {props.ended ? (
        <>
          {props.error ? <p class="error">{props.error}</p> : null}
          <p>This weekly template has ended. Shifts already on the schedule stay.</p>
        </>
      ) : (
        <>
          <p>
            This repeats one role each week. Saving it does not change shifts already on the schedule. Use Add weekly shifts to fill dates that are not there yet.
          </p>
          <TemplateForm action={props.action} csrf={props.csrf} values={props.values} error={props.error} submitLabel={props.submitLabel} />
        </>
      )}
    </>
  );
}

export function ShiftEditor(props: {
  config: AppConfig;
  heading: string;
  action: string;
  csrf: string;
  values: ShiftValues;
  eventId: number;
  eventTitle: string;
  error?: string;
  submitLabel: string;
}) {
  return (
    <div class="event-page">
      <Crumb
        items={[
          { href: appPath(props.config, '/admin'), label: 'Coordinator' },
          { href: appPath(props.config, `/admin/events/${props.eventId}`), label: props.eventTitle },
          { label: 'New shift' },
        ]}
      />
      <header class="desk-intro">
        <div class="desk-toolbar-copy">
          <h1 id="new-shift-heading">
            {props.heading}
          </h1>
          <p class="panel-note">Times use the event time zone. A shift starts and ends on the same day.</p>
        </div>
      </header>
      <section class="desk-events" aria-labelledby="new-shift-heading">
        <ShiftForm action={props.action} csrf={props.csrf} values={props.values} error={props.error} submitLabel={props.submitLabel} plain />
      </section>
    </div>
  );
}

export function ShiftRoster(props: {
  config: AppConfig;
  csrf: string;
  shift: AdminShift;
  notice?: string;
  error?: string;
  walkIn?: WalkInState;
  walkInNote?: string;
  contacts?: Contact[];
  removable?: boolean;
  moves?: { targets: MoveTarget[]; tokens: Record<number, string> };
  confirm?: ConfirmPrompt;
  editError?: string;
}) {
  const cancelledPeople = props.shift.people.filter((person) => person.status === 'cancelled');
  const confirmed = props.shift.people.filter((person) => person.status === 'confirmed').length;
  const formError = props.shift.cancelled ? undefined : props.editError;
  const bannerError = props.error ?? (props.shift.cancelled ? props.editError : undefined);
  const detailLine = props.shift.cancelled ? 'Cancelled. The roster stays until you remove it.' : props.shift.whenLabel;
  return (
    <div class="event-page">
      <Crumb
        items={[
          { href: appPath(props.config, '/admin'), label: 'Coordinator' },
          { href: appPath(props.config, `/admin/events/${props.shift.eventId}`), label: props.shift.eventTitle },
          { label: props.shift.role },
        ]}
      />
      <header class="desk-intro">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h1>{props.shift.role}</h1>
            <p class="event-status">
              <span class="shift-when">{props.shift.eventTitle}</span>
              <span class={spotClass(props.shift)}>{spotLabel(props.shift)}</span>
            </p>
          </div>
          <form method="post" action={appPath(props.config, `/admin/shifts/${props.shift.id}/export`)} class="desk-inline">
            <input type="hidden" name="csrf" value={props.csrf} />
            <button type="submit" class="btn-quiet">
              Download this roster
            </button>
          </form>
        </div>
        <p class="panel-note">A downloaded copy stays on your computer. This app does not delete it later.</p>
        {props.shift.location ? <p class="panel-note">{props.shift.location}</p> : null}
      </header>
      <Notice notice={props.notice} />
      {bannerError ? <p class="error">{bannerError}</p> : null}
      <section class="event-strip" aria-label="Shift details">
        <p class="event-strip-line">
          <strong>Shift details</strong>
          <span>{detailLine}</span>
        </p>
        {props.shift.cancelled ? null : (
          <details class="event-edit" open={formError ? true : undefined}>
            <summary>
              Edit details
              <span class="edit-chevron" aria-hidden="true" />
            </summary>
            <ShiftEditorForm config={props.config} csrf={props.csrf} shift={props.shift} error={formError} />
          </details>
        )}
      </section>
      <section class="desk-events" aria-labelledby="roster-heading">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h2 id="roster-heading">Roster</h2>
          </div>
          {cancelledPeople.length > 0 ? (
            <div class="desk-actions pick-bar">
              {cancelledPeople.length > 1 ? (
                <label class="pick-all">
                  <input type="checkbox" data-pick-all="signup" />
                  All cancelled
                </label>
              ) : null}
              <MassRemove
                pick="signup"
                action={appPath(props.config, `/admin/shifts/${props.shift.id}/signups/remove`)}
                title="Remove selected people"
                body={PERSON_DELETE_BODY}
                submit="Remove selected"
              >
                Remove selected
              </MassRemove>
            </div>
          ) : null}
        </div>
        <p class="panel-note">Cancelling a signup emails them. Their old private link stops working, and the email includes a new one.</p>
        <p class="panel-note">Moving a confirmed signup opens the spots it holds and queues a change email. Their old private link stops working.</p>
        {props.moves && props.moves.targets.length === 0 ? <p class="panel-note">No other open shift in this event has room.</p> : null}
        {props.shift.people.length === 0 ? (
          <p class="empty">No one has signed up.</p>
        ) : (
          <Roster config={props.config} csrf={props.csrf} people={props.shift.people} moves={props.moves} />
        )}
      </section>
      {props.walkIn ? (
        <section class="desk-events" aria-labelledby="walkin-heading">
          <WalkInForm
            config={props.config}
            csrf={props.csrf}
            shiftId={props.shift.id}
            spotsLeft={Math.max(0, props.shift.capacity - props.shift.occupied)}
            form={props.walkIn}
            contacts={props.contacts ?? []}
          />
        </section>
      ) : props.walkInNote ? (
        <p class="panel-note">{props.walkInNote}</p>
      ) : null}
      <div class="desk-actions">
        {props.shift.cancelled ? null : (
          <ConfirmAnchor
            class="btn btn-quiet"
            href={appPath(props.config, `/admin/shifts/${props.shift.id}/cancel`)}
            prompt={shiftCancelPrompt({
              role: props.shift.role,
              whenLabel: props.shift.whenLabel,
              cancelled: false,
              confirmed,
            })}
          >
            Cancel this shift
          </ConfirmAnchor>
        )}
        {props.removable ? (
          <ConfirmAnchor
            class="btn btn-quiet"
            href={appPath(props.config, `/admin/shifts/${props.shift.id}/remove`)}
            prompt={shiftRemovalPrompt({
              role: props.shift.role,
              whenLabel: props.shift.whenLabel,
              signupCount: props.shift.signupCount,
              weeklyActive: props.shift.weeklyActive,
              cancelled: props.shift.cancelled,
              ended: true,
            })}
          >
            Remove this shift
          </ConfirmAnchor>
        ) : null}
      </div>
      <ConfirmDialog config={props.config} csrf={props.csrf} prompt={props.confirm} />
    </div>
  );
}

export function LoginPage(props: { config: AppConfig; error?: string; accepted?: boolean }) {
  return (
    <>
      <h1>Coordinator sign-in</h1>
      {props.accepted ? <p>{ACCEPTED}</p> : <LoginForm config={props.config} error={props.error} />}
    </>
  );
}

export function LoginConfirmPage(props: { action: string; proof: string }) {
  return (
    <>
      <h1>Sign in</h1>
      <p>This signs you in on this browser. The link works once.</p>
      <form method="post" action={props.action} class="signup-form">
        <input type="hidden" name="proof" value={props.proof} />
        <button type="submit">Sign in</button>
      </form>
    </>
  );
}

export function MessagePage(props: { heading: string; message: string }) {
  return (
    <>
      <h1>{props.heading}</h1>
      <p>{props.message}</p>
    </>
  );
}

export const ACCEPTED =
  'If this address belongs to an active coordinator, a sign-in link is queued. It expires in 15 minutes. Opening the link does not sign you in.';

function EventList(props: { config: AppConfig; events: HomeEvent[]; today: string }) {
  return (
    <ul class="desk-rows">
      {props.events.map((event) => (
        <li key={event.id}>
          <a class="desk-row" href={appPath(props.config, `/admin/events/${event.id}`)}>
            <span class="desk-row-copy">
              <strong>{event.title}</strong>
              <span>{eventSummary(event, props.today)}</span>
            </span>
            <span class={event.published ? 'need-pill is-public' : 'need-pill is-hidden'}>{event.published ? 'Public' : 'Hidden'}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function ShiftNeedList(props: { config: AppConfig; shifts: HomeShift[]; today: string }) {
  return (
    <ul class="desk-rows">
      {props.shifts.map((shift) => {
        const need = needCopy(shift.occupied, shift.capacity);
        return (
          <li key={shift.id}>
            <a class="desk-row" href={appPath(props.config, `/admin/shifts/${shift.id}`)}>
              <span class="desk-row-main">
                <span class="desk-row-when">{shiftWhen(shift.date, shift.timeLabel, props.today)}</span>
                <span class="desk-row-copy">
                  <strong>{shift.role}</strong>
                  <span>{shift.eventTitle}</span>
                </span>
              </span>
              <span class={need.tone === 'needs' ? 'need-pill is-needs' : 'need-pill is-open'}>{need.text}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function FullShiftNotes(props: { shifts: HomeShift[] }) {
  return (
    <ul class="desk-full">
      {props.shifts.map((shift) => (
        <li key={shift.id}>
          <svg class="desk-full-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3.2 8.4 6.4 11.5 12.8 4.8" />
          </svg>
          {shortDate(shift.date)} {shift.role} is full.
        </li>
      ))}
    </ul>
  );
}

function eventSummary(event: HomeEvent, today: string): string {
  const count = event.shiftCount === 1 ? '1 shift' : `${event.shiftCount} shifts`;
  if (!event.nextShift) return event.shiftCount === 0 ? 'No shifts yet' : count;
  const when = event.nextShift.date === today ? `today at ${event.nextShift.timeLabel}` : `${shortDate(event.nextShift.date)} at ${event.nextShift.timeLabel}`;
  return `Next shift ${when} · ${count}`;
}

function needCopy(occupied: number, capacity: number): { text: string; tone: 'open' | 'needs' } {
  const filled = Math.min(capacity, Math.max(0, occupied));
  const open = Math.max(0, capacity - filled);
  const needs = open * 2 > capacity;
  return {
    tone: needs ? 'needs' : 'open',
    text: needs ? `Needs ${open} · ${filled} of ${capacity}` : `${open} open · ${filled} of ${capacity}`,
  };
}

function shiftWhen(date: string, timeLabel: string, today: string): string {
  if (date === today) return `Today, ${timeLabel}`;
  return `${shortDate(date)}, ${timeLabel}`;
}

function shortDate(date: string): string {
  const plain = Temporal.PlainDate.from(date);
  const weekday = SHORT_WEEKDAYS[plain.dayOfWeek % 7] ?? 'Day';
  const month = SHORT_MONTHS[plain.month - 1] ?? 'Month';
  return `${weekday}, ${month} ${plain.day}`;
}

function monthBounds(today: string, offset: number): { from: string; to: string } {
  const start = Temporal.PlainDate.from(today).with({ day: 1 }).add({ months: offset });
  const end = start.add({ months: 1 }).subtract({ days: 1 });
  return { from: start.toString(), to: end.toString() };
}

function ConfirmAnchor(props: { href: string; class?: string; label?: string; prompt: Omit<ConfirmPrompt, 'action'>; children: string }) {
  return (
    <a
      class={props.class}
      href={props.href}
      aria-label={props.label}
      data-confirm=""
      data-confirm-action={props.href}
      data-confirm-title={props.prompt.title}
      data-confirm-body={props.prompt.body}
      data-confirm-detail={props.prompt.detail}
      data-confirm-note={props.prompt.note}
      data-confirm-submit={props.prompt.submit}
    >
      {props.children}
    </a>
  );
}

function ConfirmDialog(props: { config: AppConfig; csrf: string; prompt?: ConfirmPrompt }) {
  const prompt = props.prompt;
  return (
    <>
      <dialog id="confirm" class="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body" open={prompt ? true : undefined}>
        <div class="confirm-card">
          <form method="dialog" id="confirm-dismiss" class="confirm-x">
            <button type="submit" class="event-dialog-close" aria-label="Close">
              <img src={assetHref(props.config, '/img/icons/close.svg')} alt="" />
            </button>
          </form>
          <form method="post" id="confirm-form" class="confirm-form" action={prompt?.action ?? ''} data-keep-place="">
            <input type="hidden" name="csrf" value={props.csrf} />
            <h2 id="confirm-title">{prompt?.title ?? 'Remove'}</h2>
            <p class="confirm-detail" id="confirm-detail" hidden={prompt?.detail ? undefined : true}>
              {prompt?.detail ?? ''}
            </p>
            <p class="error" id="confirm-error" hidden={prompt?.error ? undefined : true}>
              {prompt?.error ?? ''}
            </p>
            <p id="confirm-body">{prompt?.body ?? ''}</p>
            <p class="confirm-note" id="confirm-note" hidden={prompt?.note ? undefined : true}>
              {prompt?.note ?? ''}
            </p>
            <div class="confirm-actions">
              <button type="submit" id="confirm-submit" hidden={prompt?.submit ? undefined : true} disabled={prompt?.submit ? undefined : true}>
                {prompt?.submit ?? 'Remove'}
              </button>
              <button type="submit" class="btn-quiet" id="confirm-cancel" form="confirm-dismiss">
                {prompt?.submit ? 'Cancel' : 'Close'}
              </button>
            </div>
          </form>
        </div>
      </dialog>
      <script src={assetHref(props.config, '/js/confirm-dialog.js')} defer />
    </>
  );
}

function eventDeleteBody(event: { shiftCount: number; templateCount: number; signupCount: number }): string {
  const parts = ['the event'];
  if (event.shiftCount > 0) parts.push(`${event.shiftCount} ${event.shiftCount === 1 ? 'shift' : 'shifts'}`);
  if (event.templateCount > 0) parts.push(`${event.templateCount} ${event.templateCount === 1 ? 'weekly template' : 'weekly templates'}`);
  let body = `This deletes ${joinAnd(parts)}.`;
  if (event.signupCount === 1) body += ' The signup on those shifts is deleted too, including the name and email.';
  else if (event.signupCount > 1) body += ` The ${event.signupCount} signups on those shifts are deleted too, including names and emails.`;
  return `${body} It does not send email.`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function ShiftList(props: { config: AppConfig; event: AdminEvent; csrf: string; generateNote?: string; now?: string }) {
  const now = props.now;
  const today = now ? todayInZone(props.event.tz, Temporal.Instant.from(now)) : '';
  const blocks = shiftListBlocks(props.event.shifts, props.event.tz, props.now);
  const tail = blocks[blocks.length - 1];
  const footerMore = tail?.kind === 'more' ? tail : undefined;
  const body = footerMore ? blocks.slice(0, -1) : blocks;
  return (
    <>
      <section class="event-panel" aria-labelledby="shifts-heading">
        <div class="event-panel-head">
          <div class="event-panel-title">
            <h2 id="shifts-heading">Upcoming shifts</h2>
            <details class="help-tip">
              <summary aria-label="About upcoming shifts">?</summary>
              <p>
                Shifts show on the public list when this event is public and the shift is not cancelled. A shift that has already ended stays on today's card, grayed out, until midnight. Then that day leaves the list. Repeating shifts add dates for the next three months. Add weekly shifts fills those dates. Shifts already on the schedule stay as they are, including cancelled ones.
              </p>
            </details>
          </div>
          <div class="event-panel-tools">
            <a class="btn" href={appPath(props.config, `/admin/events/${props.event.id}/shifts/new`)}>
              Add a shift
            </a>
            {props.event.shifts.length > 1 ? (
              <label class="pick-all">
                <input type="checkbox" data-pick-all="shift" />
                Select all
              </label>
            ) : null}
            {props.event.shifts.length > 0 ? (
              <MassRemove
                pick="shift"
                action={appPath(props.config, `/admin/events/${props.event.id}/shifts/remove`)}
                title="Remove selected shifts"
                body={SHIFT_DELETE_BODY}
                submit="Remove selected"
                note={SHIFT_WEEKLY_NOTE}
              >
                Remove selected
              </MassRemove>
            ) : null}
          </div>
        </div>
        {blocks.length === 0 ? (
          <p class="empty">No shifts yet.</p>
        ) : (
          <>
            <ul class="shift-lines">
              {body.map((block) =>
                block.kind === 'shift' ? (
                  <ShiftLine key={block.shift.id} config={props.config} shift={block.shift} now={props.now} today={today} />
                ) : (
                  <li key={`more-${block.shifts[0]?.id ?? 'later'}`}>
                    <ShiftMore config={props.config} shifts={block.shifts} now={props.now} today={today} />
                  </li>
                ),
              )}
            </ul>
            <div class="shift-tail">
              {footerMore ? <ShiftMore config={props.config} shifts={footerMore.shifts} now={props.now} today={today} /> : null}
              <FillLegend />
            </div>
          </>
        )}
      </section>
      <WeeklyTemplates config={props.config} event={props.event} csrf={props.csrf} generateNote={props.generateNote} />
    </>
  );
}

function ShiftMore(props: { config: AppConfig; shifts: AdminShiftSummary[]; now?: string; today: string }) {
  const count = props.shifts.length;
  return (
    <details class="shift-more">
      <summary>
        <span class="shift-more-closed">
          Show {count} more {count === 1 ? 'shift' : 'shifts'}
        </span>
        <span class="shift-more-open">Show fewer</span>
      </summary>
      <ul class="shift-lines">
        {props.shifts.map((shift) => (
          <ShiftLine key={shift.id} config={props.config} shift={shift} now={props.now} today={props.today} />
        ))}
      </ul>
    </details>
  );
}

function FillLegend() {
  return (
    <ul class="fill-legend">
      <li>
        <span class="fill-dot is-full" aria-hidden="true" />
        Full
      </li>
      <li>
        <span class="fill-dot is-open" aria-hidden="true" />
        Some spots open
      </li>
      <li>
        <span class="fill-dot is-needs" aria-hidden="true" />
        Less than half filled
      </li>
    </ul>
  );
}

function ShiftLine(props: { config: AppConfig; shift: AdminShiftSummary; now?: string; today: string }) {
  const shift = props.shift;
  const removable = props.now ? shift.cancelled || shift.endsAtUtc <= props.now : false;
  const date = shiftDateParts(shift.date);
  const fill = fillStatus(shift);
  return (
    <li class="shift-line is-pick">
      <label class="pick">
        <input
          type="checkbox"
          data-pick="shift"
          data-removable={removable ? 'true' : 'false'}
          value={String(shift.id)}
          data-weekly={shift.weeklyActive ? 'true' : undefined}
        />
        <span class="sr-only">Select {shift.role}</span>
      </label>
      <a class="shift-line-link" href={appPath(props.config, `/admin/shifts/${shift.id}`)}>
        <span class="shift-date">
          <span class="shift-dow">{date.weekday}</span>
          <span class="shift-num">{date.day}</span>
          <span class="shift-mon">{date.month}</span>
        </span>
        <span class="shift-copy">
          <strong>{shift.role}</strong>
          <span>{shiftClockLine(shift, props.today)}</span>
        </span>
        <span class={`fill-pill is-${fill.tone}`}>
          {fill.tone === 'full' ? <FillCheck /> : null}
          {fill.text}
        </span>
      </a>
    </li>
  );
}

function FillCheck() {
  return (
    <svg class="fill-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.2 8.4 6.4 11.5 12.8 4.8" />
    </svg>
  );
}

type ShiftListBlock = { kind: 'shift'; shift: AdminShiftSummary } | { kind: 'more'; shifts: AdminShiftSummary[] };

function shiftListBlocks(shifts: AdminShiftSummary[], timeZone: string, now?: string): ShiftListBlock[] {
  if (!now) return shifts.map((shift) => ({ kind: 'shift', shift }));
  const cutoff = addLocalDays(todayInZone(timeZone, Temporal.Instant.from(now)), DESK_WINDOW_DAYS);
  const blocks: ShiftListBlock[] = [];
  let later: AdminShiftSummary[] = [];
  const flush = () => {
    if (later.length === 0) return;
    blocks.push({ kind: 'more', shifts: later });
    later = [];
  };
  for (const shift of shifts) {
    const tucked = !shift.cancelled && shift.endsAtUtc > now && shift.date > cutoff;
    if (tucked) later.push(shift);
    else {
      flush();
      blocks.push({ kind: 'shift', shift });
    }
  }
  flush();
  const hasOpenShown = blocks.some((block) => block.kind === 'shift' && !block.shift.cancelled && block.shift.endsAtUtc > now);
  if (hasOpenShown) return blocks;
  const moreIndex = blocks.findIndex((block) => block.kind === 'more');
  const more = blocks[moreIndex];
  if (!more || more.kind !== 'more') return blocks;
  const firstDate = more.shifts[0]?.date;
  const lead = more.shifts.filter((shift) => shift.date === firstDate);
  more.shifts = more.shifts.filter((shift) => shift.date !== firstDate);
  const leadBlocks: ShiftListBlock[] = lead.map((shift) => ({ kind: 'shift', shift }));
  if (more.shifts.length === 0) blocks.splice(moreIndex, 1, ...leadBlocks);
  else blocks.splice(moreIndex, 0, ...leadBlocks);
  return blocks;
}

function WeeklyTemplates(props: { config: AppConfig; event: AdminEvent; csrf: string; generateNote?: string }) {
  return (
    <section class="event-panel" aria-labelledby="templates-heading">
      <div class="event-panel-head">
        <div>
          <h2 id="templates-heading">Repeating shifts</h2>
          <p class="event-panel-note">
            Each one adds three months ahead.{' '}
            <button type="submit" class="text-action" form="add-weekly">
              Add weekly shifts
            </button>
          </p>
        </div>
        <a class="btn btn-line" href={appPath(props.config, `/admin/events/${props.event.id}/templates/new`)}>
          Add a repeating shift
        </a>
      </div>
      <form id="add-weekly" method="post" action={appPath(props.config, `/admin/events/${props.event.id}/generate`)} hidden>
        <input type="hidden" name="csrf" value={props.csrf} />
      </form>
      {props.generateNote ? <p class="error">{props.generateNote}</p> : null}
      {props.event.templates.length === 0 ? (
        <p class="empty">No repeating shifts yet.</p>
      ) : (
        <ul class="repeat-lines">
          {props.event.templates.map((template) => (
            <TemplateCard key={template.id} config={props.config} eventId={props.event.id} template={template} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateCard(props: { config: AppConfig; eventId: number; template: AdminTemplate }) {
  const template = props.template;
  const spots = template.capacity === 1 ? '1 spot' : `${template.capacity} spots`;
  const when = template.endsOn ? `${mediumDate(template.startsOn)} to ${mediumDate(template.endsOn)}` : `since ${mediumDate(template.startsOn)}`;
  return (
    <li class="repeat-line">
      <span class="repeat-copy">
        <strong>
          Every {weekdayName(template.weekday)} · {template.role}
        </strong>
        <span>
          {timeRange(template.start, template.end)} · {spots} · {when}
          {template.active ? '' : ' · ended'}
        </span>
      </span>
      {template.active ? (
        <a class="btn btn-line" href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}`)}>
          Edit
        </a>
      ) : null}
      <details class="more-menu">
        <summary aria-label={`More actions for ${template.role}`}>
          <span aria-hidden="true">⋯</span>
        </summary>
        <div class="more-menu-pop">
          {template.active ? (
            <ConfirmAnchor href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}/end`)} prompt={templateEndPrompt(template)}>
              End
            </ConfirmAnchor>
          ) : (
            <ConfirmAnchor href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}/remove`)} prompt={templateRemovalPrompt(template)}>
              Remove
            </ConfirmAnchor>
          )}
        </div>
      </details>
    </li>
  );
}

function TemplateForm(props: { action: string; csrf: string; values: TemplateValues; error?: string; submitLabel: string }) {
  return (
    <form method="post" action={props.action} class="signup-form">
      <input type="hidden" name="csrf" value={props.csrf} />
      {props.error ? <p class="error">{props.error}</p> : null}
      <label>
        Role
        <input name="role" type="text" required value={props.values.role} />
      </label>
      <label>
        Day
        <select name="weekday" required>
          <option value="" selected={props.values.weekday === '' ? true : undefined}>
            Choose a day
          </option>
          {WEEKDAYS.map((name, index) => (
            <option value={String(index)} selected={props.values.weekday === String(index) ? true : undefined}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Start
        <input name="start" type="time" required value={props.values.start} />
      </label>
      <label>
        End
        <input name="end" type="time" required value={props.values.end} />
      </label>
      <label>
        Capacity
        <input name="capacity" type="number" min="1" max="500" required value={props.values.capacity} />
      </label>
      <label>
        First date
        <input name="startsOn" type="date" required value={props.values.startsOn} />
      </label>
      <label>
        Last date
        <input name="endsOn" type="date" value={props.values.endsOn} />
        <span class="hint">Leave this blank to keep adding weeks.</span>
      </label>
      <button type="submit">{props.submitLabel}</button>
    </form>
  );
}

function EventForm(props: {
  action: string;
  csrf: string;
  values: EventValues;
  error?: string;
  submitLabel: string;
  creating?: boolean;
  heading?: string;
  headingId?: string;
  wide?: boolean;
}) {
  return (
    <form method="post" action={props.action} class={props.wide ? 'signup-form event-details-form' : 'signup-form'}>
      {props.heading ? <h2 id={props.headingId}>{props.heading}</h2> : null}
      <input type="hidden" name="csrf" value={props.csrf} />
      {props.creating ? <input type="hidden" name="tz" value={props.values.tz} /> : null}
      {props.error ? <p class="error">{props.error}</p> : null}
      <label>
        Title
        <input name="title" type="text" required value={props.values.title} />
      </label>
      {props.creating ? null : (
        <label>
          Public address
          <input name="slug" type="text" value={props.values.slug} />
          <span class="hint">Letters, numbers, and hyphens. Leave this blank to build it from the title. This becomes /e/this-address.</span>
        </label>
      )}
      <label>
        Description
        <textarea name="description">{props.values.description}</textarea>
      </label>
      {props.creating ? null : (
        <>
          <label>
            Location
            <input name="location" type="text" value={props.values.location} />
            <span class="hint">Changing the location emails people on shifts that have not ended.</span>
          </label>
          <label>
            Time zone
            <input name="tz" type="text" required value={props.values.tz} />
            <span class="hint">Use an IANA time zone, such as America/Chicago.</span>
          </label>
        </>
      )}
      <label class="check">
        <input type="checkbox" name="published" value="yes" checked={props.values.published ? true : undefined} />
        Show this event on the public list
      </label>
      <button type="submit">{props.submitLabel}</button>
    </form>
  );
}

function ShiftForm(props: { action: string; csrf: string; values: ShiftValues; error?: string; note?: string; submitLabel: string; plain?: boolean }) {
  return (
    <form method="post" action={props.action} class={props.plain ? 'signup-form event-details-form' : 'signup-form'}>
      <input type="hidden" name="csrf" value={props.csrf} />
      {props.error ? <p class="error">{props.error}</p> : null}
      {props.note ? <p class="event-panel-note">{props.note}</p> : null}
      <label>
        Role
        <input name="role" type="text" required value={props.values.role} />
      </label>
      <label>
        Date
        <input name="date" type="date" required value={props.values.date} />
      </label>
      <label>
        Start
        <input name="start" type="time" required value={props.values.start} />
      </label>
      <label>
        End
        <input name="end" type="time" required value={props.values.end} />
      </label>
      <label>
        Capacity
        <input name="capacity" type="number" min="1" max="500" required value={props.values.capacity} />
      </label>
      <button type="submit">{props.submitLabel}</button>
    </form>
  );
}

function ShiftEditorForm(props: { config: AppConfig; csrf: string; shift: AdminShift; error?: string }) {
  return (
    <ShiftForm
      action={appPath(props.config, `/admin/shifts/${props.shift.id}`)}
      csrf={props.csrf}
      error={props.error}
      note="Changing the role, date, or time emails everyone who is signed up and replaces their private links."
      submitLabel="Save shift"
      plain
      values={{
        role: props.shift.role,
        date: props.shift.date,
        start: props.shift.start,
        end: props.shift.end,
        capacity: String(props.shift.capacity),
      }}
    />
  );
}

function WalkInForm(props: {
  config: AppConfig;
  csrf: string;
  shiftId: number;
  spotsLeft: number;
  form: WalkInState;
  contacts: Contact[];
}) {
  const values = props.form.values;
  const errors = props.form.errors;
  const errorEntries = Object.entries(errors).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const contactId = props.form.contactId ?? '';
  return (
    <form method="post" action={appPath(props.config, `/admin/shifts/${props.shiftId}/walk-in`)} class="signup-form event-details-form">
      <h2 id="walkin-heading">Add a walk-in</h2>
      <p>Choose how many people are here, including the person named below. This signup holds that many spots and queues one confirmation email. Another person can use the same email. The name is listed on the public sign-up page when this shift is posted there. Email and notes stay off that page.</p>
      {props.form.message ? <p class="error">{props.form.message}</p> : null}
      {errorEntries.length > 0 ? (
        <div class="error" role="alert">
          <p>Check these fields:</p>
          <ul>
            {errorEntries.map(([field, message]) => (
              <li key={field}>
                <a href={`#walkin-${field}`}>{message}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <input type="hidden" name="csrf" value={props.csrf} />
      <input type="hidden" name="form_token" value={props.form.token} />
      {props.contacts.length > 0 ? (
        <label for="walkin-contact">
          Saved contact
          <select id="walkin-contact" name="contact" data-contact="" aria-describedby="walkin-contact-hint">
            <option value="" selected={contactId === '' ? true : undefined}>
              Type their details
            </option>
            {props.contacts.map((person) => (
              <option
                value={String(person.id)}
                key={person.id}
                selected={contactId === String(person.id) ? true : undefined}
                data-name={person.name}
                data-email={person.email}
                data-phone={person.phone ?? ''}
              >
                {person.name}, {person.email}
              </option>
            ))}
          </select>
          <span class="hint" id="walkin-contact-hint">
            Optional. Choosing someone fills their name, email, and phone. A blank field uses the saved contact. Typing someone who is not on the list saves them here when the walk-in is added.
          </span>
        </label>
      ) : null}
      <WalkInField id="walkin-name" label="Name" name="name" type="text" value={values.name} error={errors.name} />
      <WalkInField id="walkin-email" label="Email" name="email" type="email" value={values.email} error={errors.email} />
      <WalkInField id="walkin-phone" label="Phone" name="phone" type="tel" value={values.phone} error={errors.phone} required />
      <PartySizeField idPrefix="walkin" value={values.partySize} error={errors.partySize} remaining={props.spotsLeft} />
      <label for="walkin-notes">
        Notes (optional)
        <textarea id="walkin-notes" name="notes" aria-invalid={errors.notes ? 'true' : undefined} aria-describedby={errors.notes ? 'walkin-notes-error' : undefined}>
          {values.notes}
        </textarea>
        {errors.notes ? (
          <span class="field-error" id="walkin-notes-error">
            {errors.notes}
          </span>
        ) : null}
      </label>
      <button type="submit">Add to this shift</button>
    </form>
  );
}

function WalkInField(props: {
  id: string;
  label: string;
  name: string;
  type: 'text' | 'email' | 'tel';
  value: string;
  error?: string;
  hint?: string;
  required?: boolean;
}) {
  const errorId = `${props.id}-error`;
  const hintId = `${props.id}-hint`;
  const describedBy = [props.hint ? hintId : '', props.error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <label for={props.id}>
      {props.label}
      <input
        id={props.id}
        name={props.name}
        type={props.type}
        value={props.value}
        autocomplete="off"
        required={props.required ? true : undefined}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy}
      />
      {props.hint ? (
        <span class="hint" id={hintId}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? (
        <span class="field-error" id={errorId}>
          {props.error}
        </span>
      ) : null}
    </label>
  );
}

function Roster(props: { config: AppConfig; csrf: string; people: RosterPerson[]; moves?: { targets: MoveTarget[]; tokens: Record<number, string> } }) {
  return (
    <ul class="shift-list">
      {props.people.map((person) => (
        <li class="shift-card" key={person.id}>
          <p class="person-head">
            {person.status === 'cancelled' ? (
              <label class="pick">
                <input type="checkbox" data-pick="signup" value={String(person.id)} />
                <span class="sr-only">Select {person.name}</span>
              </label>
            ) : null}
            <strong>{person.name}</strong>
          </p>
          {person.groupSize > 1 ? <p>Holds {person.groupSize} spots</p> : null}
          <p>{person.email}</p>
          {person.phone ? <p>{person.phone}</p> : null}
          {person.notes ? <p>Note: {person.notes}</p> : null}
          <p>{person.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</p>
          {person.status === 'cancelled' ? (
            <p>
              <ConfirmAnchor
                href={appPath(props.config, `/admin/signups/${person.id}/remove`)}
                prompt={signupRemovalPrompt({ name: person.name, status: person.status })}
              >
                Remove from roster
              </ConfirmAnchor>
            </p>
          ) : null}
          {person.status === 'confirmed' ? (
            <>
              <p>
                <ConfirmAnchor
                  class="text-action"
                  href={appPath(props.config, `/admin/signups/${person.id}/cancel`)}
                  prompt={signupCancelPrompt({ name: person.name, status: person.status })}
                >
                  Cancel signup
                </ConfirmAnchor>
              </p>
              {props.moves && props.moves.targets.length > 0 && props.moves.tokens[person.id] ? (
                <form method="post" action={appPath(props.config, `/admin/signups/${person.id}/move`)} class="move-form">
                  <input type="hidden" name="csrf" value={props.csrf} />
                  <input type="hidden" name="move_token" value={props.moves.tokens[person.id]} />
                  <label for={`move-${person.id}`}>
                    Move to
                    <select id={`move-${person.id}`} name="destination" required>
                      <ShiftTargetOptions targets={props.moves.targets} />
                    </select>
                  </label>
                  <button type="submit">Move</button>
                </form>
              ) : null}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LoginForm(props: { config: AppConfig; error?: string }) {
  return (
    <>
      <p>Use the coordinator email address. The sign-in link expires in 15 minutes and works once.</p>
      <noscript>
        <p>Signing in needs JavaScript for the abuse check.</p>
      </noscript>
      <form method="post" action={appPath(props.config, '/login')} class="signup-form">
        {props.error ? (
          <p class="error" role="alert">
            {props.error}
          </p>
        ) : null}
        <div class="hp" aria-hidden="true">
          <label>
            Company website
            <input name="company_website" type="text" tabIndex={-1} autocomplete="off" value="" />
          </label>
        </div>
        <label>
          Email
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <div class="cf-turnstile" data-sitekey={props.config.turnstile.siteKey} data-action="login" />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </>
  );
}

function BackupSavedToday() {
  return (
    <>
      <svg class="desk-note-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.2 8.4 6.4 11.5 12.8 4.8" />
      </svg>
      Backup saved today
    </>
  );
}

function BackupNote(props: { text: string }) {
  const match = /^(.*?)([A-Z][a-z]+ \d{1,2}, \d{4})(.*)$/.exec(props.text);
  if (!match) return <>{props.text}</>;
  return (
    <>
      {match[1]}
      <strong>{match[2]}</strong>
      {match[3]}
    </>
  );
}

function Notice(props: { notice?: string; text?: string }) {
  const text = props.text ?? (props.notice ? NOTICES[props.notice] : undefined);
  if (!text) return null;
  return (
    <p class="notice" data-notice>
      <span>{text}</span>
      <button type="button" class="notice-dismiss" data-dismiss-notice aria-label="Dismiss">
        <span aria-hidden="true">×</span>
      </button>
    </p>
  );
}

function MassRemove(props: { pick: 'shift' | 'signup'; action: string; title: string; body: string; submit: string; note?: string; children: string }) {
  return (
    <button
      type="button"
      class="btn btn-quiet"
      hidden={true}
      data-confirm=""
      data-confirm-pick={props.pick}
      data-confirm-action={props.action}
      data-confirm-title={props.title}
      data-confirm-body={props.body}
      data-confirm-note-weekly={props.note}
      data-confirm-submit={props.submit}
    >
      {props.children}
    </button>
  );
}

function spotClass(shift: Pick<AdminShiftSummary, 'capacity' | 'occupied' | 'cancelled'>): string {
  if (shift.cancelled) return 'event-pill is-hidden';
  return shift.occupied >= shift.capacity ? 'event-pill is-full' : 'event-pill is-open';
}

function spotLabel(shift: Pick<AdminShiftSummary, 'capacity' | 'occupied' | 'cancelled'>): string {
  if (shift.cancelled) return 'Cancelled';
  return spotsSentence(shift);
}

const NOTICES: Record<string, string> = {
  saved: 'Saved.',
  'signup-cancelled': 'The signup is cancelled. A cancellation email is queued.',
  'already-cancelled': 'That signup was already cancelled.',
  'shift-cancelled': 'The shift is cancelled. Cancellation emails are queued.',
  'shift-closed': 'The shift is cancelled. No one needed an email.',
  'walk-in': 'They are on this shift. A confirmation email is queued.',
  moved: 'They are on this shift. A change email is queued.',
  generated: 'Weekly shifts for the next three months are on the schedule. Existing shifts were left as they are.',
  'no-template': 'There is no active weekly template.',
  'template-saved': 'The weekly template is saved. Shifts already on the schedule were not changed.',
  'template-ended': 'This weekly template has ended. Shifts already on the schedule stay.',
  'signup-removed': 'That person is removed from the roster.',
  'signups-removed': 'Those people are removed from the roster.',
  'shift-removed': 'That shift is removed.',
  'shifts-removed': 'Those shifts are removed.',
  'template-removed': 'That weekly template is removed. Shifts already on the schedule stay, and they are no longer tied to the weekly pattern.',
  'event-removed': 'That event is removed.',
  'settings-saved': 'Settings saved.',
  'admin-added': 'That person can sign in. Ask them to request a sign-in link. This did not send email.',
  'admin-restored': 'That person can sign in again.',
  'admin-removed': 'That person can no longer sign in.',
  'contact-removed': 'That person is removed from the contact list.',
  'contact-saved': 'That contact is saved.',
  'contact-updated': 'That contact is updated.',
  'contact-matched': 'That email is already on the contact list.',
  'contact-corrected': 'That contact is corrected.',
  'contact-same': 'That contact already matches.',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? 'Day';
}

function clockLabel(time: string): string {
  const parts = clockParts(time);
  if (!parts) return time;
  return `${parts.hour}:${parts.minute} ${parts.suffix}`;
}

function clockParts(time: string): { hour: number; minute: string; suffix: string } | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(time);
  const hourText = match?.[1];
  const minute = match?.[2];
  if (!hourText || !minute) return null;
  const hour24 = Number(hourText);
  return { hour: hour24 % 12 === 0 ? 12 : hour24 % 12, minute, suffix: hour24 < 12 ? 'AM' : 'PM' };
}

function timeRange(start: string, end: string): string {
  const from = clockParts(start);
  const to = clockParts(end);
  if (!from || !to) return `${clockLabel(start)} to ${clockLabel(end)}`;
  if (from.suffix === to.suffix) return `${from.hour}:${from.minute} to ${to.hour}:${to.minute} ${to.suffix}`;
  return `${from.hour}:${from.minute} ${from.suffix} to ${to.hour}:${to.minute} ${to.suffix}`;
}

function shiftDateParts(date: string): { weekday: string; day: string; month: string } {
  const plain = Temporal.PlainDate.from(date);
  return {
    weekday: (SHORT_WEEKDAYS[plain.dayOfWeek % 7] ?? 'Day').toUpperCase(),
    day: String(plain.day),
    month: SHORT_MONTHS[plain.month - 1] ?? 'Month',
  };
}

function mediumDate(date: string): string {
  const plain = Temporal.PlainDate.from(date);
  const month = SHORT_MONTHS[plain.month - 1] ?? 'Month';
  return `${month} ${plain.day}, ${plain.year}`;
}

function shiftClockLine(shift: Pick<AdminShiftSummary, 'date' | 'start' | 'end'>, today: string): string {
  const range = timeRange(shift.start, shift.end);
  return shift.date === today ? `Today · ${range}` : range;
}

function fillStatus(shift: Pick<AdminShiftSummary, 'capacity' | 'occupied' | 'cancelled'>): { tone: 'full' | 'open' | 'needs' | 'cancelled'; text: string } {
  if (shift.cancelled) return { tone: 'cancelled', text: 'Cancelled' };
  const filled = Math.min(shift.capacity, Math.max(0, shift.occupied));
  const open = Math.max(0, shift.capacity - filled);
  if (open === 0) return { tone: 'full', text: `Full · ${filled} of ${shift.capacity}` };
  if (open * 2 > shift.capacity) return { tone: 'needs', text: `Needs ${open} · ${filled} of ${shift.capacity}` };
  return { tone: 'open', text: `${open} open · ${filled} of ${shift.capacity}` };
}
