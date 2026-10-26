import { Temporal } from '@js-temporal/polyfill';

/** How far ahead a volunteer can join a shift, counted from today in the event's time zone. */
export const SIGNUP_WINDOW_MONTHS = 3;

export const SIGNUP_TOO_EARLY = 'Sign-up opens three months before this shift.';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Last local date, inclusive, that is open for signup on `today`. */
export function signupDeadline(today: string): string {
  return Temporal.PlainDate.from(today).add({ months: SIGNUP_WINDOW_MONTHS }).toString();
}

export function isWithinSignupWindow(date: string, today: string): boolean {
  return date <= signupDeadline(today);
}

export function signupDeadlineLabel(today: string): string {
  const date = Temporal.PlainDate.from(signupDeadline(today));
  const month = MONTHS[date.month - 1];
  if (!month) throw new Error(`${today} is not a date.`);
  return `${month} ${date.day}, ${date.year}`;
}
