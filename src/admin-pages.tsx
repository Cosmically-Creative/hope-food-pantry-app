import { Temporal } from '@js-temporal/polyfill';
import type { AdminEvent, AdminEventSummary, AdminShift, AdminShiftSummary, AdminTemplate, MoveTarget, RosterPerson } from './admin/store.js';
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
} from './contacts.js';
import type { SignupErrors, SignupValues } from './signup-form.js';
import { addLocalDays, todayInZone } from './time.js';
import { ShiftTargetOptions } from './shift-options.js';
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
const PERSON_DELETE_BODY = 'This deletes their name, email, phone, guardian details, and notes from the roster. It does not send email.';
const PERSON_WAIT_BODY = 'Cancel this signup before removing it.';
const PERSON_CANCEL_BODY = 'Cancelling a signup emails them. Their old private link stops working, and the email includes a new one.';
const SHIFT_CANCEL_EMPTY = 'No one is signed up. Cancelling closes the shift and does not send email.';
const SHIFT_CANCEL_STAY = 'The roster stays. After it is empty, the shift can be removed.';
const SHIFT_ALREADY = 'This shift is already cancelled.';
const VISIBLE_SHIFT_DAYS = 14;
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

export function AdminHome(props: {
  config: AppConfig;
  name: string;
  events: AdminEventSummary[];
  csrf: string;
  notice?: string;
  exportFrom?: string;
  exportTo?: string;
  exportError?: string;
  backupNote: string;
  backupState: 'saved' | 'waiting' | 'behind';
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
  return (
    <>
      <header class="desk-intro">
        <h1>Coordinator</h1>
        <p class="desk-signed">
          Signed in as <strong>{props.name}</strong>.
        </p>
        <p class="desk-note">
          <BackupNote text={props.backupNote} />
        </p>
      </header>
      <Notice notice={props.notice} />
      <section class="desk-events" aria-labelledby="events-heading">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h2 id="events-heading">Events</h2>
            <p>Every event is here, including ones that are off the public list.</p>
          </div>
          <div class="desk-actions">
            <a class="btn" href={appPath(props.config, '/admin/events/new')} data-open-event>
              New event
            </a>
            <a class="btn btn-quiet" href={appPath(props.config, '/admin/contacts')}>
              Contacts
            </a>
            <a class="btn btn-quiet" href={appPath(props.config, '/admin/settings')}>
              Settings
            </a>
          </div>
        </div>
        {props.events.length === 0 ? <p class="empty">No events yet.</p> : <EventList config={props.config} events={props.events} />}
      </section>
      <form method="post" action={appPath(props.config, '/admin/export')} class="signup-form desk-download">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Download signups</h2>
        <p>
          Download signups whose shift date falls in this range. The date is the event's local date. A downloaded copy stays on your computer. This app does not delete it later.
        </p>
        {props.exportError ? <p class="error">{props.exportError}</p> : null}
        <div class="desk-range">
          <label>
            From
            <input name="from" type="date" required value={props.exportFrom ?? ''} />
          </label>
          <label>
            To
            <input name="to" type="date" required value={props.exportTo ?? ''} />
          </label>
          <button type="submit">Download this date range</button>
        </div>
      </form>
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
      <p>
        <a href={appPath(props.config, '/admin')}>Coordinator</a>
      </p>
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
          <span class="hint">The default is 24, counted after the shift ends. After 1:00 AM Central Time, signups older than this lose their name, email, phone, guardian, and notes in this app. A spreadsheet already downloaded is left as it is.</span>
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

function contactListHref(config: AppConfig, query: string, shown: number): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('shown', String(shown));
  return `${appPath(config, '/admin/contacts')}?${params.toString()}#contact-more`;
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
  return (
    <>
      <p>
        <a href={appPath(props.config, '/admin')}>Coordinator</a>
      </p>
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
      <p>
        Someone who signs up is saved here. Cancelling that signup does not remove them. A different name is a separate contact, even when the email matches. To add someone who has not signed up, import a spreadsheet or save them below. That does not take a spot and does not send email. Choose a name to correct that person or add them to an open shift. Old signups lose their details after the retention period. This list stays until you remove someone.
      </p>
      <form method="post" action={appPath(props.config, '/admin/contacts/new')} class="signup-form desk-download">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Add a contact</h2>
        <p>This saves one person. It does not sign them up and does not send email. The same name and email updates that person. A different name is saved separately, even with the same email. A blank phone does not erase a phone already saved. Names are capitalized. A 10-digit phone is saved with dashes, like 712-555-0100.</p>
        <WalkInField id="contact-first" label="First name" name="first_name" type="text" value={manual.values.firstName} error={manual.errors.firstName} />
        <WalkInField id="contact-last" label="Last name" name="last_name" type="text" value={manual.values.lastName} error={manual.errors.lastName} />
        <WalkInField id="contact-email" label="Email" name="email" type="email" value={manual.values.email} error={manual.errors.email} />
        <WalkInField id="contact-phone" label="Phone (optional)" name="phone" type="tel" value={manual.values.phone} error={manual.errors.phone} hint="We will not text them" />
        <button type="submit">Save this contact</button>
      </form>
      <form method="post" action={appPath(props.config, '/admin/contacts/import')} class="signup-form desk-download" enctype="multipart/form-data">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Import a contact list</h2>
        <p>
          Use a spreadsheet with First Name, Last Name, Email, and Phone. The SignUpGenius people export works. Address is ignored. The same name and email updates that person. A different name stays a separate person, even when the email matches. A different email stays a separate person, even when the name matches. A blank phone does not erase a phone already saved. Names are capitalized. A 10-digit phone is saved with dashes, like 712-555-0100. Email addresses are stored in lowercase. The file has to be under 64 KB.
        </p>
        {props.importError ? <p class="error">{props.importError}</p> : null}
        <label>
          Spreadsheet
          <input name="file" type="file" accept=".csv,text/csv,text/plain" required />
        </label>
        <button type="submit">Import this list</button>
      </form>
      <form method="post" action={appPath(props.config, '/admin/contacts/export')} class="signup-form desk-download">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Download contacts</h2>
        <p>A downloaded copy stays on your computer. This app does not delete it later. The Address column is blank. A cell that would be a spreadsheet formula is saved as text.</p>
        <button type="submit">Download contacts</button>
      </form>
      <section class="desk-events" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading">{heading}</h2>
        {props.total > 0 ? (
          <form method="get" action={appPath(props.config, '/admin/contacts')} class="signup-form desk-download">
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
  return (
    <>
      <p>
        <a href={appPath(props.config, '/admin/contacts')}>Contacts</a>
      </p>
      <h1>{props.contact.name}</h1>
      <p>{props.contact.email}</p>
      {props.contact.phone ? <p>{props.contact.phone}</p> : null}
      <Notice notice={props.notice} />
      <form method="post" action={appPath(props.config, `/admin/contacts/${props.contact.id}`)} class="signup-form">
        <input type="hidden" name="csrf" value={props.csrf} />
        <h2>Correct this contact</h2>
        <p>
          This changes the saved person. A different name stays this contact and does not create a second person. It does not change a signup, take a spot, or send email. Names are capitalized. A 10-digit phone is saved with dashes, like 712-555-0100. A blank phone removes the saved number.
        </p>
        <WalkInField id="correct-first" label="First name" name="first_name" type="text" value={correction.values.firstName} error={correction.errors.firstName} />
        <WalkInField id="correct-last" label="Last name" name="last_name" type="text" value={correction.values.lastName} error={correction.errors.lastName} />
        <WalkInField id="correct-email" label="Email" name="email" type="email" value={correction.values.email} error={correction.errors.email} />
        <WalkInField
          id="correct-phone"
          label="Phone (optional)"
          name="phone"
          type="tel"
          value={correction.values.phone}
          error={correction.errors.phone}
          hint="We will not text them"
        />
        <button type="submit">Save this correction</button>
      </form>
      {props.error ? <p class="error">{props.error}</p> : null}
      <h2>Add to a shift</h2>
      <p>Choose an open shift. This uses their saved name, email, and phone. It takes one spot and queues a confirmation email. Their name stays off the public list. Full, cancelled, and ended shifts are left off this list, and so is a shift they are already on.</p>
      {props.shifts.length > 0 ? (
        <form method="post" action={appPath(props.config, `/admin/contacts/${props.contact.id}/add`)} class="signup-form">
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
          <label class="check" for="add-under-18">
            <input id="add-under-18" name="under18" type="checkbox" value="yes" data-under-18="" checked={values.under18 ? true : undefined} />
            They are under 18
          </label>
          <fieldset data-guardian="">
            <legend>Parent or guardian</legend>
            <WalkInField id="add-guardianName" label="Guardian name" name="guardianName" type="text" value={values.guardianName} error={errors.guardianName} />
            <WalkInField id="add-guardianEmail" label="Guardian email" name="guardianEmail" type="email" value={values.guardianEmail} error={errors.guardianEmail} />
          </fieldset>
          <button type="submit">Add to this shift</button>
        </form>
      ) : (
        <p class="empty">No open shift is available.</p>
      )}
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
  return (
    <div class="event-page">
      <header class="desk-intro">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h1>{props.heading}</h1>
            {props.event ? (
              <p class="event-status">
                <span class={props.event.published ? 'event-pill' : 'event-pill is-hidden'}>
                  {props.event.published ? 'On the public list' : 'Not on the public list'}
                </span>
              </p>
            ) : null}
          </div>
          {props.event ? (
            <form method="post" action={appPath(props.config, `/admin/events/${props.event.id}/export`)} class="desk-inline">
              <input type="hidden" name="csrf" value={props.csrf} />
              <button type="submit" class="btn-quiet">
                Download this event
              </button>
            </form>
          ) : null}
        </div>
        {props.event ? <p class="panel-note">A downloaded copy stays on your computer. This app does not delete it later.</p> : null}
      </header>
      <Notice notice={props.notice} />
      {props.event ? (
        <ShiftList config={props.config} event={props.event} csrf={props.csrf} generateNote={props.generateNote} now={props.now} />
      ) : null}
      <section class="desk-events" aria-labelledby="details-heading">
        <div class="desk-toolbar-copy">
          <h2 id="details-heading">Event details</h2>
        </div>
        <EventForm action={props.action} csrf={props.csrf} values={props.values} error={props.error} submitLabel={props.submitLabel} wide />
        {props.event ? (
          <p class="event-remove">
            <ConfirmAnchor
              href={appPath(props.config, `/admin/events/${props.event.id}/remove`)}
              prompt={eventRemovalPrompt({
                title: props.event.title,
                published: props.event.published,
                shiftCount: props.event.shifts.length,
                templateCount: props.event.templates.length,
                signupCount: props.event.shifts.reduce((sum, shift) => sum + shift.signupCount, 0),
              })}
            >
              Remove this event
            </ConfirmAnchor>
          </p>
        ) : null}
      </section>
      {props.event ? <ConfirmDialog config={props.config} csrf={props.csrf} prompt={props.confirm} /> : null}
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
  ended?: boolean;
  error?: string;
  submitLabel: string;
}) {
  return (
    <>
      <p>
        <a href={appPath(props.config, `/admin/events/${props.eventId}`)}>Back to the event</a>
      </p>
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
  error?: string;
  submitLabel: string;
}) {
  return (
    <div class="event-page">
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
}) {
  const cancelledPeople = props.shift.people.filter((person) => person.status === 'cancelled');
  const confirmed = props.shift.people.filter((person) => person.status === 'confirmed').length;
  return (
    <div class="event-page">
      <header class="desk-intro">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h1>{props.shift.role}</h1>
            <p class="event-status">
              <span class="shift-when">{props.shift.eventTitle}</span>
              <span class="shift-when">{props.shift.whenLabel}</span>
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
      {props.error ? <p class="error">{props.error}</p> : null}
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
        <p class="panel-note">Attendance stays on this roster. It does not send email, and it does not change how many spots are open.</p>
        <p class="panel-note">Moving a confirmed signup opens this spot and queues a change email. Their old private link stops working.</p>
        {props.moves && props.moves.targets.length === 0 ? <p class="panel-note">No other open shift in this event has room.</p> : null}
        {props.shift.people.length === 0 ? (
          <p class="empty">No one has signed up.</p>
        ) : (
          <Roster config={props.config} csrf={props.csrf} people={props.shift.people} moves={props.moves} />
        )}
      </section>
      {props.walkIn ? (
        <section class="desk-events" aria-labelledby="walkin-heading">
          <WalkInForm config={props.config} csrf={props.csrf} shiftId={props.shift.id} form={props.walkIn} contacts={props.contacts ?? []} />
        </section>
      ) : props.walkInNote ? (
        <p class="panel-note">{props.walkInNote}</p>
      ) : null}
      <section class="desk-events" aria-labelledby="shift-edit-heading">
        {props.shift.cancelled ? (
          <>
            <div class="desk-toolbar-copy">
              <h2 id="shift-edit-heading">This shift</h2>
            </div>
            <p class="panel-note">This shift is cancelled. The roster stays until you remove it.</p>
          </>
        ) : (
          <ShiftEditorForm config={props.config} csrf={props.csrf} shift={props.shift} />
        )}
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
      </section>
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

function EventList(props: { config: AppConfig; events: AdminEventSummary[] }) {
  return (
    <ul class="event-board">
      {props.events.map((event) => (
        <li key={event.id}>
          <a class="event-card" href={appPath(props.config, `/admin/events/${event.id}`)}>
            <span class="event-card-title">{event.title}</span>
            <span class="event-card-foot">
              <span class={event.published ? 'event-pill' : 'event-pill is-hidden'}>
                {event.published ? 'On the public list' : 'Not on the public list'}
              </span>
              <span class="event-count">
                {event.shiftCount} {event.shiftCount === 1 ? 'shift' : 'shifts'}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function ConfirmAnchor(props: { href: string; class?: string; prompt: Omit<ConfirmPrompt, 'action'>; children: string }) {
  return (
    <a
      class={props.class}
      href={props.href}
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
  const removableCount = now ? props.event.shifts.filter((shift) => shift.cancelled || shift.endsAtUtc <= now).length : 0;
  const blocks = shiftListBlocks(props.event.shifts, props.event.tz, props.now);
  return (
    <>
      <section class="desk-events" aria-labelledby="shifts-heading">
        <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h2 id="shifts-heading">Shifts</h2>
          </div>
          <div class="desk-actions">
            <a class="btn" href={appPath(props.config, `/admin/events/${props.event.id}/shifts/new`)}>
              Add a shift
            </a>
            <form method="post" action={appPath(props.config, `/admin/events/${props.event.id}/generate`)} class="desk-inline">
              <input type="hidden" name="csrf" value={props.csrf} />
              <button type="submit" class="btn-quiet">
                Add weekly shifts
              </button>
            </form>
          </div>
        </div>
        <p class="panel-note">
          Shifts show on the public list when this event is public, the shift is not cancelled, and it has not ended. Weekly templates add their shifts for the next eight weeks. Shifts already on the schedule stay as they are, including cancelled ones.
        </p>
        {props.generateNote ? <p class="error">{props.generateNote}</p> : null}
        {removableCount > 0 ? (
          <div class="desk-actions pick-bar">
            {removableCount > 1 ? (
              <label class="pick-all">
                <input type="checkbox" data-pick-all="shift" />
                All removable
              </label>
            ) : null}
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
          </div>
        ) : null}
        {blocks.length === 0 ? (
          <p class="empty">No shifts yet.</p>
        ) : (
          <ul class="event-board">
            {blocks.map((block) =>
              block.kind === 'shift' ? (
                <ShiftCard key={block.shift.id} config={props.config} shift={block.shift} now={props.now} />
              ) : (
                <li key={`more-${block.shifts[0]?.id ?? 'later'}`}>
                  <details class="shift-more">
                    <summary>
                      <span class="shift-more-closed">
                        See {block.shifts.length} more {block.shifts.length === 1 ? 'shift' : 'shifts'}
                      </span>
                      <span class="shift-more-open">Show fewer</span>
                    </summary>
                    <ul class="event-board">
                      {block.shifts.map((shift) => (
                        <ShiftCard key={shift.id} config={props.config} shift={shift} now={props.now} />
                      ))}
                    </ul>
                  </details>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
      <WeeklyTemplates config={props.config} event={props.event} />
    </>
  );
}

function ShiftCard(props: { config: AppConfig; shift: AdminShiftSummary; now?: string }) {
  const shift = props.shift;
  const removable = props.now ? shift.cancelled || shift.endsAtUtc <= props.now : false;
  const summary = (
    <>
      <span class="event-card-title">{shift.role}</span>
      <span class="event-card-foot">
        <span class="shift-when">{shift.whenLabel}</span>
        <span class={spotClass(shift)}>{spotLabel(shift)}</span>
      </span>
    </>
  );
  return (
    <li>
      {removable ? (
        <div class="event-card">
          <label class="pick">
            <input type="checkbox" data-pick="shift" value={String(shift.id)} data-weekly={shift.weeklyActive ? 'true' : undefined} />
            <span class="sr-only">Select {shift.role}</span>
          </label>
          <a class="shift-open" href={appPath(props.config, `/admin/shifts/${shift.id}`)}>
            {summary}
          </a>
          <ConfirmAnchor
            class="shift-remove"
            href={appPath(props.config, `/admin/shifts/${shift.id}/remove`)}
            prompt={shiftRemovalPrompt({
              role: shift.role,
              whenLabel: shift.whenLabel,
              signupCount: shift.signupCount,
              weeklyActive: shift.weeklyActive,
              cancelled: shift.cancelled,
              ended: true,
            })}
          >
            Remove
          </ConfirmAnchor>
        </div>
      ) : (
        <a class="event-card" href={appPath(props.config, `/admin/shifts/${shift.id}`)}>
          {summary}
        </a>
      )}
    </li>
  );
}

type ShiftListBlock = { kind: 'shift'; shift: AdminShiftSummary } | { kind: 'more'; shifts: AdminShiftSummary[] };

function shiftListBlocks(shifts: AdminShiftSummary[], timeZone: string, now?: string): ShiftListBlock[] {
  if (!now) return shifts.map((shift) => ({ kind: 'shift', shift }));
  const cutoff = addLocalDays(todayInZone(timeZone, Temporal.Instant.from(now)), VISIBLE_SHIFT_DAYS);
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

function WeeklyTemplates(props: { config: AppConfig; event: AdminEvent }) {
  return (
    <section class="desk-events" aria-labelledby="templates-heading">
      <div class="desk-toolbar">
          <div class="desk-toolbar-copy">
            <h2 id="templates-heading">Weekly templates</h2>
          </div>
          <div class="desk-actions">
            <a class="btn" href={appPath(props.config, `/admin/events/${props.event.id}/templates/new`)}>
              Add a weekly template
            </a>
          </div>
        </div>
        <p class="panel-note">
          A weekly template repeats one role. Saving or ending it does not change shifts already on the schedule. Ending it stops later weeks from being added.
        </p>
      {props.event.templates.length === 0 ? (
        <p class="empty">No weekly template yet.</p>
      ) : (
        <ul class="event-board">
          {props.event.templates.map((template) => (
            <li class="shift-row" key={template.id}>
              <TemplateCard config={props.config} eventId={props.event.id} template={template} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateSummary(props: { template: AdminTemplate; ended?: boolean }) {
  const template = props.template;
  const range = template.endsOn ? `from ${template.startsOn} through ${template.endsOn}` : `from ${template.startsOn}`;
  return (
    <>
      <span class="event-card-title">
        {weekdayName(template.weekday)}, {template.role}
      </span>
      <span class="event-card-foot">
        <span class="shift-when">
          {clockLabel(template.start)} to {clockLabel(template.end)}, {range}
        </span>
        <span class="event-pill">
          {template.capacity} {template.capacity === 1 ? 'spot' : 'spots'}
        </span>
        {props.ended ? <span class="event-pill is-hidden">Ended</span> : null}
      </span>
    </>
  );
}

function TemplateCard(props: { config: AppConfig; eventId: number; template: AdminTemplate }) {
  const template = props.template;
  return (
    <>
      {template.active ? (
        <>
          <a class="event-card" href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}`)}>
            <TemplateSummary template={template} />
          </a>
          <ConfirmAnchor
            class="btn btn-quiet"
            href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}/end`)}
            prompt={templateEndPrompt(template)}
          >
            End
          </ConfirmAnchor>
        </>
      ) : (
        <>
          <div class="event-card is-static">
            <TemplateSummary template={template} ended />
          </div>
          <ConfirmAnchor
            class="btn btn-quiet"
            href={appPath(props.config, `/admin/events/${props.eventId}/templates/${template.id}/remove`)}
            prompt={templateRemovalPrompt(template)}
          >
            Remove
          </ConfirmAnchor>
        </>
      )}
    </>
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

function ShiftForm(props: { action: string; csrf: string; values: ShiftValues; error?: string; submitLabel: string; plain?: boolean }) {
  return (
    <form method="post" action={props.action} class={props.plain ? 'signup-form event-details-form' : 'signup-form'}>
      <input type="hidden" name="csrf" value={props.csrf} />
      {props.error ? <p class="error">{props.error}</p> : null}
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

function ShiftEditorForm(props: { config: AppConfig; csrf: string; shift: AdminShift }) {
  return (
    <>
      <div class="desk-toolbar-copy">
        <h2 id="shift-edit-heading">Edit this shift</h2>
      </div>
      <p class="panel-note">Changing the role, date, or time emails everyone who is signed up and replaces their private links.</p>
      <ShiftForm
        action={appPath(props.config, `/admin/shifts/${props.shift.id}`)}
        csrf={props.csrf}
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
    </>
  );
}

function WalkInForm(props: { config: AppConfig; csrf: string; shiftId: number; form: WalkInState; contacts: Contact[] }) {
  const values = props.form.values;
  const errors = props.form.errors;
  const errorEntries = Object.entries(errors).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const contactId = props.form.contactId ?? '';
  return (
    <form method="post" action={appPath(props.config, `/admin/shifts/${props.shiftId}/walk-in`)} class="signup-form event-details-form">
      <h2 id="walkin-heading">Add a walk-in</h2>
      <p>This is one person who is here. It takes one spot and queues a confirmation email. Another person can use the same email. Their name stays off the public list.</p>
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
      <WalkInField id="walkin-phone" label="Phone (optional)" name="phone" type="tel" value={values.phone} error={errors.phone} hint="We will not text you" />
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
      <label class="check" for="walkin-under-18">
        <input id="walkin-under-18" name="under18" type="checkbox" value="yes" data-under-18="" checked={values.under18 ? true : undefined} />
        They are under 18
      </label>
      <fieldset data-guardian="">
        <legend>Parent or guardian</legend>
        <WalkInField id="walkin-guardianName" label="Guardian name" name="guardianName" type="text" value={values.guardianName} error={errors.guardianName} />
        <WalkInField id="walkin-guardianEmail" label="Guardian email" name="guardianEmail" type="email" value={values.guardianEmail} error={errors.guardianEmail} />
      </fieldset>
      <button type="submit">Add to this shift</button>
    </form>
  );
}

function WalkInField(props: { id: string; label: string; name: string; type: 'text' | 'email' | 'tel'; value: string; error?: string; hint?: string }) {
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
          <p>{person.email}</p>
          {person.phone ? <p>{person.phone}</p> : null}
          {person.minor ? <p>Under 18</p> : null}
          {person.guardianName || person.guardianEmail ? (
            <p>
              Guardian: {person.guardianName} {person.guardianEmail}
            </p>
          ) : null}
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
              <p>{attendanceLabel(person.attendance)}</p>
              <form method="post" action={appPath(props.config, `/admin/signups/${person.id}/attendance`)} class="attendance-actions">
                <input type="hidden" name="csrf" value={props.csrf} />
                <button type="submit" name="mark" value="attended" aria-pressed={person.attendance === 'attended' ? 'true' : 'false'}>
                  Attended
                </button>
                <button type="submit" name="mark" value="no-show" aria-pressed={person.attendance === 'no-show' ? 'true' : 'false'}>
                  No-show
                </button>
                {person.attendance ? (
                  <button type="submit" name="mark" value="clear">
                    Clear
                  </button>
                ) : null}
              </form>
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

function attendanceLabel(attendance: RosterPerson['attendance']): string {
  if (attendance === 'attended') return 'Attended.';
  if (attendance === 'no-show') return 'No-show.';
  return 'Attendance is not marked.';
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
  attended: 'Marked attended.',
  'no-show': 'Marked as a no-show.',
  'attendance-cleared': 'The attendance mark is cleared.',
  moved: 'They are on this shift. A change email is queued.',
  generated: 'Weekly shifts for the next eight weeks are on the schedule. Existing shifts were left as they are.',
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
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${match[2]} ${suffix}`;
}
