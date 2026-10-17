import type { Child } from 'hono/jsx';
import type { AppConfig } from './config.js';
import { WEEKDAY_SHORT, calendarMonth, calendarToday, chooseCalendarMonth, monthStep, type CalendarDay } from './calendar.js';
import { spotsSentence, type PublicEvent, type PublicShift } from './schedule.js';
import type { SignupErrors, SignupValues } from './signup-form.js';
import type { MoveTarget } from './admin/store.js';
import type { ManageView } from './signup.js';
import { appPath } from './url.js';

const PANTRY_SITE = 'https://hopefoodpantrysc.org';

function asset(config: AppConfig, file: string): string {
  return appPath(config, file);
}

function pathIs(path: string | undefined, target: string): boolean {
  if (!path) return false;
  return path === target || path.startsWith(`${target}/`);
}

export function Layout(props: {
  config: AppConfig;
  title: string;
  path?: string;
  turnstile?: boolean;
  account?: { csrf: string } | null;
  children?: Child;
}) {
  const home = appPath(props.config, '/');
  const coordinator = appPath(props.config, props.account ? '/admin' : '/login');
  const coordinatorHere = pathIs(props.path, coordinator);
  const volunteeringCurrent = props.path === home ? 'page' : undefined;
  const logo = asset(props.config, '/img/logo.png');
  const menu = asset(props.config, '/img/icons/menu.svg');
  const close = asset(props.config, '/img/icons/close.svg');
  const facebook = asset(props.config, '/img/icons/facebook.svg');
  const instagram = asset(props.config, '/img/icons/instagram.svg');
  const wave = asset(props.config, '/img/wave-secondary.svg');
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href={asset(props.config, '/img/favicons/favicon.png')} />
        <link rel="apple-touch-icon" href={asset(props.config, '/img/favicons/favicon-apple.png')} />
        <link rel="stylesheet" href={appPath(props.config, '/brand/tokens.css')} />
        <link rel="stylesheet" href={appPath(props.config, '/css/app.css')} />
        <script src={appPath(props.config, '/js/desk.js')} />
      </head>
      <body>
        <a class="skip-link" href="#content">
          Skip to content
        </a>
        <header class="header">
          <nav class="nav" aria-label="Primary">
            <a href={`${PANTRY_SITE}/`}>
              <img class="logo" src={logo} alt="Hope Food Pantry logo" />
            </a>
            <ul class="nav-links">
              <li>
                <a class="main-nav-link" href={`${PANTRY_SITE}/`}>
                  Home
                </a>
              </li>
              <li>
                <a class="main-nav-link" href={`${PANTRY_SITE}/about`}>
                  About
                </a>
              </li>
              <li>
                <a class="main-nav-link" href={`${PANTRY_SITE}/faq`}>
                  FAQ
                </a>
              </li>
              <li>
                <a class="main-nav-link" href={home} aria-current={volunteeringCurrent}>
                  Volunteering
                </a>
              </li>
              <li>
                <a class="main-nav-link" href={`${PANTRY_SITE}/#contact`}>
                  Contact
                </a>
              </li>
              <li>
                <a class="btn" href="https://donorbox.org/hope-food-pantry-1">
                  Donate
                </a>
              </li>
            </ul>
            <button class="btn-mobile-nav" type="button" aria-expanded="false" aria-label="Menu">
              <img class="icon-mobile-nav" src={menu} alt="" name="open" />
              <img class="icon-mobile-nav" src={close} alt="" name="close" />
            </button>
          </nav>
        </header>
        <main id="content" tabIndex={-1}>
          <div class="session-bar">
            <a href={home} aria-current={props.path === home ? 'page' : undefined}>
              Calendar
            </a>
            <a href={coordinator} class={props.account ? undefined : 'session-entry'} aria-current={coordinatorHere ? 'page' : undefined}>
              Coordinator
            </a>
            {props.account ? (
              <form method="post" action={appPath(props.config, '/logout')} class="session-logout">
                <input type="hidden" name="csrf" value={props.account.csrf} />
                <button type="submit">Log out</button>
              </form>
            ) : null}
          </div>
          {props.children}
        </main>
        <footer class="footer">
          <img class="wave wave-secondary" src={wave} alt="" />
          <nav class="footer-nav" aria-label="Footer">
            <div>
              <a href={`${PANTRY_SITE}/`}>
                <img class="logo" src={logo} alt="Hope Food Pantry logo" />
              </a>
              <p class="equal-text">
                Hope Food Pantry is an{' '}
                <a href="https://www.usda.gov/sites/default/files/documents/ad-475a.pdf" target="_blank" rel="noopener noreferrer">
                  equal opportunity provider.
                </a>
              </p>
            </div>
            <div class="footer-cell">
              <h3>Contact Us</h3>
              <p>
                <a href="tel:+17125409351">712‑540‑9351</a>
              </p>
              <p>
                <a href="mailto:hopepantry@gmail.com">hopepantry@gmail.com</a>
              </p>
              <div class="social-links">
                <a href="https://www.facebook.com/schopefoodpantry" target="_blank" rel="noopener noreferrer">
                  <div class="social-flex">
                    <img src={facebook} alt="facebook icon" />
                    <p>schopefoodpantry</p>
                  </div>
                </a>
                <a href="https://www.instagram.com/hopefoodpantrysc" target="_blank" rel="noopener noreferrer">
                  <div class="social-flex">
                    <img src={instagram} alt="instagram icon" />
                    <p>hopefoodpantrysc</p>
                  </div>
                </a>
              </div>
            </div>
            <div class="footer-cell">
              <h3>Address</h3>
              <address>
                <p>
                  4155 US 75 Ave
                  <br />
                  Sioux Center, IA 51250
                  <br />
                  (Rear of Property)
                </p>
                <br />
                <p>Mail to: PO Box 21</p>
              </address>
            </div>
            <div class="footer-cell">
              <h3>Navigation</h3>
              <ul class="footer-nav-links">
                <li>
                  <a class="main-nav-link" href={`${PANTRY_SITE}/`}>
                    Home
                  </a>
                </li>
                <li>
                  <a class="main-nav-link" href={`${PANTRY_SITE}/about`}>
                    About
                  </a>
                </li>
                <li>
                  <a class="main-nav-link" href={`${PANTRY_SITE}/faq`}>
                    FAQ
                  </a>
                </li>
                <li>
                  <a class="main-nav-link" href={home} aria-current={volunteeringCurrent}>
                    Volunteering
                  </a>
                </li>
                <li>
                  <a class="main-nav-link" href={`${PANTRY_SITE}/#contact`}>
                    Contact
                  </a>
                </li>
                <li>
                  <a class="main-nav-link" href="https://donorbox.org/hope-food-pantry-1">
                    Donate
                  </a>
                </li>
              </ul>
            </div>
          </nav>
          <p class="copyright-text">
            Hope Food Pantry © 2026 | Design & Development by{' '}
            <a href="https://cosmicallycreative.com" target="_blank" rel="noopener noreferrer">
              Cosmically Creative
            </a>
          </p>
        </footer>
        {props.turnstile ? <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer /> : null}
        <script src={appPath(props.config, '/js/enhance.js')} defer />
      </body>
    </html>
  );
}

export function EmptySchedulePage() {
  return (
    <>
      <h1>Weekly pantry</h1>
      <p class="empty">No upcoming shifts are posted.</p>
    </>
  );
}

export function EventPage(props: { config: AppConfig; event: PublicEvent; now: string; month?: string; path?: string }) {
  const description = props.event.description.trim();
  return (
    <>
      <h1>{props.event.title}</h1>
      {props.event.location ? <p class="location">{props.event.location}</p> : null}
      {props.event.slug === 'weekly-pantry' ? null : <p class="zone">Times are shown in {props.event.timeZone}.</p>}
      {description ? <p class="description">{description}</p> : null}
      {props.event.shifts.length === 0 ? (
        <p class="empty">No upcoming shifts are posted for this event.</p>
      ) : (
        <ShiftCalendar
          config={props.config}
          event={props.event}
          now={props.now}
          month={props.month}
          path={props.path ?? `/e/${encodeURIComponent(props.event.slug)}`}
        />
      )}
    </>
  );
}

export type SignupFormView = {
  token: string;
  siteKey: string;
  values: SignupValues;
  errors: SignupErrors;
};

export function ShiftPage(props: {
  config: AppConfig;
  shift: PublicShift;
  signup?: SignupFormView | null;
  notice?: string;
}) {
  const description = props.shift.event.description.trim();
  return (
    <>
      <h1>{props.shift.role}</h1>
      {props.shift.event.location ? <p class="location">{props.shift.event.location}</p> : null}
      <ShiftWhen shift={props.shift} />
      <StatusLine shift={props.shift} />
      {description ? <p class="description">{description}</p> : null}
      {props.notice ? (
        <p class="error" role="alert">
          {props.notice}
        </p>
      ) : null}
      {props.signup ? <SignupForm config={props.config} shiftId={props.shift.id} form={props.signup} /> : null}
    </>
  );
}

export function ConfirmationPage(props: {
  config: AppConfig;
  shift: PublicShift;
  name: string | null;
  managePath: string | null;
  cancelled?: boolean;
}) {
  return (
    <>
      <h1>{props.cancelled ? 'This signup is cancelled' : "You're signed up"}</h1>
      <p>
        {props.cancelled
          ? `${props.name ? `${props.name} is no longer signed up for ` : 'This signup is no longer for '}${props.shift.role}.`
          : `${props.name ? `${props.name} is signed up for ` : 'This signup is for '}${props.shift.role}.`}
      </p>
      <ShiftWhen shift={props.shift} />
      {props.managePath ? (
        <>
          <p>
            {props.cancelled
              ? 'A cancellation email is queued. This link still opens the cancelled signup.'
              : 'A confirmation email is queued. Save this link too, in case the email is delayed. It opens this signup, where you can cancel it or switch it to another open shift.'}
          </p>
          <p>
            <a href={props.managePath}>Open this signup</a>
          </p>
        </>
      ) : (
        <p>If you just signed up, the link stays in this browser for a few minutes. A confirmation email is queued.</p>
      )}
    </>
  );
}

export type SwitchForm = {
  action: string;
  token: string;
  formToken: string;
  targets: MoveTarget[];
};

export function ManagePage(props: {
  signup: ManageView;
  cancel: { action: string; token: string } | null;
  switches: SwitchForm | null;
  reminders?: { action: string; token: string } | 'off' | null;
  notice?: string;
  note?: string;
}) {
  const signup = props.signup;
  return (
    <>
      <h1>Your signup</h1>
      <p class="status">{signup.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</p>
      <p>{signup.eventTitle}</p>
      <h2>{signup.role}</h2>
      <p class="when">
        <time dateTime={signup.when.date}>{signup.when.dateLabel}</time> {signup.when.timeLabel} {signup.when.abbreviation}
      </p>
      {signup.location ? <p class="location">{signup.location}</p> : null}
      <dl class="details">
        <div>
          <dt>Name</dt>
          <dd>{signup.name}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{signup.email}</dd>
        </div>
        {signup.phone ? (
          <div>
            <dt>Phone</dt>
            <dd>{signup.phone}</dd>
          </div>
        ) : null}
        {signup.isMinor ? (
          <div>
            <dt>Guardian</dt>
            <dd>
              {signup.guardianName}
              {signup.guardianEmail ? ` (${signup.guardianEmail})` : ''}
            </dd>
          </div>
        ) : null}
        {signup.notes ? (
          <div>
            <dt>Notes</dt>
            <dd class="description">{signup.notes}</dd>
          </div>
        ) : null}
      </dl>
      {props.note ? <p class="status">{props.note}</p> : null}
      {props.notice ? (
        <p class="error" role="alert">
          {props.notice}
        </p>
      ) : null}
      {props.switches ? (
        props.switches.targets.length === 0 ? (
          <p>There is no other open shift you can switch to.</p>
        ) : (
          <form class="move-form" method="post" action={props.switches.action}>
            <p>Switch to another shift in this event. This opens your spot here and queues a change email. This link stops working, and the next page has the new one.</p>
            <input type="hidden" name="switch_token" value={props.switches.token} />
            <input type="hidden" name="form_token" value={props.switches.formToken} />
            <label for="switch-to">
              Switch to
              <select id="switch-to" name="destination" required>
                <option value="">Choose a shift</option>
                {props.switches.targets.map((target) => (
                  <option value={String(target.id)} key={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Switch</button>
          </form>
        )
      ) : null}
      {props.reminders === 'off' ? (
        <p>Reminder emails for this signup are off. The signup stays. Confirmation, change, and cancellation emails still arrive.</p>
      ) : null}
      <div class="manage-actions">
        {props.reminders && props.reminders !== 'off' ? (
          <form class="cancel-form" method="post" action={props.reminders.action}>
            <p>Stop reminder emails for this signup. The signup stays. Confirmation, change, and cancellation emails still arrive.</p>
            <input type="hidden" name="reminder_token" value={props.reminders.token} />
            <button type="submit">Stop reminder emails</button>
          </form>
        ) : null}
        {props.cancel ? (
          <form class="cancel-form" method="post" action={props.cancel.action}>
            <p>Cancel this signup to open the spot for someone else. A cancellation email is queued when you cancel.</p>
            <input type="hidden" name="cancel_token" value={props.cancel.token} />
            <button type="submit">Cancel this signup</button>
          </form>
        ) : (
          <p>This signup is cancelled. The spot is open for someone else. A cancellation email is queued.</p>
        )}
      </div>
    </>
  );
}

// TODO(D3): The pantry still has to approve this wording, including retention and copies.
// A blank setting keeps the unapproved message. Saved wording is shown as written, escaped, and is not a policy by itself.
export function PrivacyPage(props: { paragraphs: string[] }) {
  return (
    <>
      <h1>Privacy</h1>
      {props.paragraphs.length === 0 ? (
        <>
          <p>Hope Volunteer does not have an approved privacy notice yet.</p>
          <p>When the pantry approves the wording, it will appear on this page. This page is not a privacy policy.</p>
        </>
      ) : (
        props.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
      )}
    </>
  );
}

export function SwitchAlreadyPage() {
  return (
    <>
      <h1>Your signup</h1>
      <p>This signup was already switched. Use the link in the email.</p>
    </>
  );
}

export function ReminderOffPage(props: { config: AppConfig; token: string; replyTo: string; off: boolean; error?: string }) {
  return (
    <>
      <h1>Reminder emails</h1>
      {props.error ? (
        <p class="error" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.off ? (
        <p>Reminder emails for this signup are off. The signup stays. Confirmation, change, and cancellation emails still arrive.</p>
      ) : (
        <form method="post" action={appPath(props.config, `/u/${props.token}`)} class="cancel-form">
          <p>This turns off reminder emails for this signup. It does not cancel the signup. Confirmation, change, and cancellation emails still arrive.</p>
          <p>The pantry reads mail sent to {props.replyTo}. This button turns reminders off immediately.</p>
          <button type="submit">Stop reminder emails</button>
        </form>
      )}
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1>That page is not available</h1>
      <p>The link may be out of date, or the shift is not posted.</p>
    </>
  );
}

export function ProblemPage() {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>The page could not be loaded. Try again in a little while.</p>
    </>
  );
}

export function WaitPage() {
  return (
    <>
      <h1>Please wait</h1>
      <p>Too many attempts. Please wait and try again.</p>
    </>
  );
}

function monthHref(config: AppConfig, path: string, monthId: string): string {
  return `${appPath(config, path)}?month=${monthId}`;
}

function MonthArrow(props: { config: AppConfig; path: string; monthId: string; direction: 'prev' | 'next' }) {
  const next = props.direction === 'next';
  return (
    <a class="month-arrow" rel={props.direction} href={monthHref(props.config, props.path, props.monthId)}>
      <span class="sr-only">{next ? 'Next month' : 'Previous month'}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={next ? 'M9.5 5.5 16 12l-6.5 6.5' : 'M14.5 5.5 8 12l6.5 6.5'} />
      </svg>
    </a>
  );
}

function ShiftCalendar(props: {
  config: AppConfig;
  event: PublicEvent;
  now: string;
  month?: string;
  path: string;
}) {
  const today = calendarToday(props.event.timeZone, props.now);
  const dates = props.event.shifts.map((shift) => shift.when.date);
  const monthId = chooseCalendarMonth(props.month, dates, today);
  const month = calendarMonth(monthId);
  const step = monthStep(monthId, dates);
  const shiftsByDate = new Map<string, PublicShift[]>();
  for (const shift of props.event.shifts) {
    if (shift.when.date.slice(0, 7) !== month.id) continue;
    const listed = shiftsByDate.get(shift.when.date);
    if (listed) listed.push(shift);
    else shiftsByDate.set(shift.when.date, [shift]);
  }
  const titleId = `month-${props.event.id}-${month.id}`;
  const shiftsThisMonth = [...shiftsByDate.values()].some((listed) => listed.length > 0);
  return (
    <div class="shift-calendar">
      <section class="cal-month" aria-labelledby={titleId}>
        <div class="month-nav">
          {step.previous ? (
            <MonthArrow config={props.config} path={props.path} monthId={step.previous} direction="prev" />
          ) : (
            <span class="month-nav-slot"></span>
          )}
          <h2 id={titleId} class="cal-title">
            {month.label}
          </h2>
          {step.next ? (
            <MonthArrow config={props.config} path={props.path} monthId={step.next} direction="next" />
          ) : (
            <span class="month-nav-slot"></span>
          )}
        </div>
        <div class="cal-weekdays" aria-hidden="true">
          {WEEKDAY_SHORT.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <ol class="cal-weeks">
          {month.weeks.map((week) => {
            const weekStart = week[0];
            if (!weekStart) return null;
            return (
              <li class="cal-week" key={weekStart.date}>
                <ol class="cal-week-days">
                  {week.map((day) => (
                    <CalendarDayCell
                      key={day.date}
                      config={props.config}
                      day={day}
                      today={today}
                      weekName={`shifts-${weekStart.date}`}
                      shifts={shiftsByDate.get(day.date) ?? []}
                    />
                  ))}
                </ol>
                <div class="week-tray"></div>
              </li>
            );
          })}
        </ol>
        {shiftsThisMonth ? null : <p class="empty">No shifts this month.</p>}
      </section>
    </div>
  );
}

function CalendarDayCell(props: { config: AppConfig; day: CalendarDay; today: string; weekName: string; shifts: PublicShift[] }) {
  if (!props.day.inMonth) return <li class="cal-day is-outside" aria-hidden="true"></li>;
  const today = props.day.date === props.today;
  const className = ['cal-day', today ? 'is-today' : '', props.day.date < props.today ? 'is-past' : '', props.shifts.length > 0 ? 'has-shifts' : 'is-empty']
    .filter(Boolean)
    .join(' ');
  return (
    <li class={className} aria-current={today ? 'date' : undefined}>
      <div class="cal-day-face">
        <p class="day-label">
          <DayStamp day={props.day} today={today} />
          {today ? (
            <span class="today-flag" aria-hidden="true">
              Today
            </span>
            ) : null}
          </p>
        {props.shifts.length > 0 ? (
          <details class="day-reveal" name={props.weekName} data-date={props.day.date}>
            <summary class="day-summary">
              <DayStamp day={props.day} today={today} />
              <span class="day-markers">
                {today ? (
                  <span class="today-flag" aria-hidden="true">
                    Today
                  </span>
                ) : null}
                <span class="event-dot" aria-hidden="true"></span>
                <span class="expand-chevron" aria-hidden="true"></span>
              </span>
              <span class="sr-only">Show shifts</span>
            </summary>
          </details>
        ) : null}
        {props.shifts.length > 0 ? (
          <div class="shift-drawer" data-date={props.day.date}>
            <p class="tray-label">
              {props.day.weekday} {props.day.day}
            </p>
            <ShiftList config={props.config} shifts={props.shifts} className="day-shifts" />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function DayStamp(props: { day: CalendarDay; today: boolean }) {
  return (
    <time dateTime={props.day.date}>
      <span class="day-full sr-only">{props.today ? `Today, ${props.day.label}` : props.day.label}</span>
      <span class="day-weekday" aria-hidden="true">
        {props.day.weekday}
      </span>
      <span class="day-num" aria-hidden="true">
        {props.day.day}
      </span>
    </time>
  );
}

function ShiftList(props: { config: AppConfig; shifts: PublicShift[]; className: string }) {
  return (
    <ul class={props.className}>
      {props.shifts.map((shift) => (
        <li key={shift.id}>
          <CalendarShift config={props.config} shift={shift} />
        </li>
      ))}
    </ul>
  );
}

function CalendarShift(props: { config: AppConfig; shift: PublicShift }) {
  const shift = props.shift;
  const closed = shift.full || shift.cancelled || shift.ended;
  const action = closed ? 'View shift' : 'Sign up';
  return (
    <a class="cal-shift" href={appPath(props.config, `/s/${shift.id}`)}>
      <span class="cal-line">
        {shift.when.startLabel} {shift.role}
      </span>
      <span class="sr-only">
        {'. '}
        {action} for {shift.role} on {shift.when.dateLabel}, {shift.when.startLabel} to {shift.when.endLabel}{' '}
        {shift.when.abbreviation}. {spotsSentence(shift)}
        {shift.inProgress ? ' In progress.' : ''}
      </span>
      <div class="cal-detail" aria-hidden="true">
        <span class="cal-hold" aria-hidden="true"></span>
        <span class="role">{shift.role}</span>
        <span class="when">
          <time dateTime={shift.startsAtUtc}>{shift.when.startLabel}</time>
          {' to '}
          {shift.when.sameDay ? null : <time dateTime={shift.endsAtUtc}>{shift.when.endDateLabel} </time>}
          <time dateTime={shift.endsAtUtc}>{shift.when.endLabel}</time> {shift.when.abbreviation}
        </span>
        {shift.inProgress ? <span class="status">In progress</span> : null}
        <Spots shift={shift} />
        <span class="cal-action">{action}</span>
      </div>
    </a>
  );
}

function ShiftWhen(props: { shift: PublicShift }) {
  const shift = props.shift;
  return (
    <p class="when">
      <time dateTime={shift.startsAtUtc}>{shift.when.startLabel}</time>
      {' to '}
      {shift.when.sameDay ? null : (
        <time dateTime={shift.endsAtUtc}>{shift.when.endDateLabel} </time>
      )}
      <time dateTime={shift.endsAtUtc}>{shift.when.endLabel}</time> {shift.when.abbreviation}
    </p>
  );
}

function Spots(props: { shift: PublicShift }) {
  return <p class={props.shift.full ? 'spots is-full' : 'spots is-open'}>{spotsSentence(props.shift)}</p>;
}

function SignupForm(props: { config: AppConfig; shiftId: number; form: SignupFormView }) {
  const form = props.form;
  const errors = form.errors;
  const errorEntries = Object.entries(errors).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <form class="signup-form" method="post" action={appPath(props.config, `/s/${props.shiftId}`)}>
      <h2>Sign up</h2>
      <p>Each signup is for one person and takes one spot. Another person can use the same email address. If you are under 18, add a parent or guardian.</p>
      <noscript>
        <p class="error">Signing up needs JavaScript for the abuse check. The pantry has not published a contact method for help with signup.</p>
      </noscript>
      {errorEntries.length > 0 ? (
        <div class="error" role="alert">
          <p>Check these fields:</p>
          <ul>
            {errorEntries.map(([field, message]) => (
              <li key={field}>
                <a href={`#signup-${field}`}>{message}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <input type="hidden" name="form_token" value={form.token} />
      <div class="hp" aria-hidden="true">
        <label>
          Company website
          <input name="company_website" type="text" tabindex={-1} autocomplete="off" value="" />
        </label>
      </div>
      <Field id="signup-name" label="Name" name="name" type="text" value={form.values.name} error={errors.name} autoComplete="name" />
      <Field id="signup-email" label="Email" name="email" type="email" value={form.values.email} error={errors.email} autoComplete="email" />
      <Field
        id="signup-phone"
        label="Phone (optional)"
        name="phone"
        type="tel"
        value={form.values.phone}
        error={errors.phone}
        autoComplete="tel"
        hint="We will not text you"
      />
      <label for="signup-notes">
        Notes (optional)
        <textarea id="signup-notes" name="notes" aria-invalid={errors.notes ? 'true' : undefined} aria-describedby={errors.notes ? 'signup-notes-error' : undefined}>
          {form.values.notes}
        </textarea>
        {errors.notes ? (
          <span class="field-error" id="signup-notes-error">
            {errors.notes}
          </span>
        ) : null}
      </label>
      <label class="check" for="signup-under-18">
        <input id="signup-under-18" name="under18" type="checkbox" value="yes" data-under-18="" checked={form.values.under18 ? true : undefined} />
        I am under 18
      </label>
      <fieldset data-guardian="">
        <legend>Parent or guardian</legend>
        <Field
          id="signup-guardianName"
          label="Guardian name"
          name="guardianName"
          type="text"
          value={form.values.guardianName}
          error={errors.guardianName}
          autoComplete="name"
        />
        <Field
          id="signup-guardianEmail"
          label="Guardian email"
          name="guardianEmail"
          type="email"
          value={form.values.guardianEmail}
          error={errors.guardianEmail}
          autoComplete="email"
        />
      </fieldset>
      <div class="cf-turnstile" data-sitekey={form.siteKey} data-action="signup" />
      <p id="signup-turnstile-hint">This check confirms the signup came from a browser.</p>
      <button type="submit">Sign up</button>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  name: string;
  type: 'text' | 'email' | 'tel';
  value: string;
  error?: string;
  autoComplete: string;
  hint?: string;
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
        autocomplete={props.autoComplete}
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

function StatusLine(props: { shift: PublicShift }) {
  if (props.shift.cancelled) return <p class="status">Cancelled. This shift is closed.</p>;
  if (props.shift.ended) return <p class="status">Ended. This shift is closed.</p>;
  return (
    <>
      {props.shift.inProgress ? <p class="status">In progress</p> : null}
      <Spots shift={props.shift} />
    </>
  );
}
