import { Temporal } from '@js-temporal/polyfill';
import { assertSameDayShift, LocalTimeError } from '../time.js';

export type EventValues = {
  title: string;
  slug: string;
  description: string;
  location: string;
  tz: string;
  published: boolean;
};

export type EventInput = {
  title: string;
  slug: string;
  description: string;
  location: string;
  tz: string;
  published: boolean;
};

export type ShiftValues = {
  role: string;
  date: string;
  start: string;
  end: string;
  capacity: string;
};

export type ShiftInput = {
  role: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
};

export function eventValuesFrom(body: Record<string, unknown>, fallbackTz: string): EventValues {
  return {
    title: text(body, 'title'),
    slug: text(body, 'slug'),
    description: text(body, 'description'),
    location: text(body, 'location'),
    tz: text(body, 'tz') || fallbackTz,
    published: text(body, 'published') === 'yes',
  };
}

export function parseEvent(values: EventValues): { ok: true; value: EventInput } | { ok: false; error: string } {
  const title = values.title.trim();
  if (title.length === 0) return { ok: false, error: 'Enter a title.' };
  if (title.length > 120) return { ok: false, error: 'Use a shorter title.' };
  const slug = values.slug.trim() ? normalizeSlug(values.slug) : normalizeSlug(title);
  if (!validSlug(slug)) return { ok: false, error: 'Use a public address with lowercase letters, numbers, and hyphens.' };
  const description = values.description.trim();
  if (description.length > 2000) return { ok: false, error: 'Use a shorter description.' };
  const location = values.location.trim();
  if (location.length > 200) return { ok: false, error: 'Use a shorter location.' };
  const tz = values.tz.trim();
  if (tz.length === 0) return { ok: false, error: 'Enter a time zone.' };
  return { ok: true, value: { title, slug, description, location, tz, published: values.published } };
}

export function shiftValuesFrom(body: Record<string, unknown>): ShiftValues {
  return {
    role: text(body, 'role'),
    date: text(body, 'date'),
    start: clock(text(body, 'start')),
    end: clock(text(body, 'end')),
    capacity: text(body, 'capacity'),
  };
}

export function parseShift(values: ShiftValues): { ok: true; value: ShiftInput } | { ok: false; error: string } {
  const role = values.role.trim();
  if (role.length === 0) return { ok: false, error: 'Enter a role.' };
  if (role.length > 80) return { ok: false, error: 'Use a shorter role.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return { ok: false, error: 'Enter a date.' };
  if (!/^\d{2}:\d{2}$/.test(values.start)) return { ok: false, error: 'Enter a start time as HH:MM.' };
  if (!/^\d{2}:\d{2}$/.test(values.end)) return { ok: false, error: 'Enter an end time as HH:MM.' };
  if (!/^[1-9][0-9]*$/.test(values.capacity)) return { ok: false, error: 'Enter a capacity of at least 1.' };
  const capacity = Number(values.capacity);
  if (!Number.isSafeInteger(capacity) || capacity > 500) return { ok: false, error: 'Capacity cannot be more than 500.' };
  return { ok: true, value: { role, date: values.date, start: values.start, end: values.end, capacity } };
}

export type TemplateValues = {
  role: string;
  weekday: string;
  start: string;
  end: string;
  capacity: string;
  startsOn: string;
  endsOn: string;
};

export type TemplateInput = {
  role: string;
  weekday: number;
  start: string;
  end: string;
  capacity: number;
  startsOn: string;
  endsOn: string | null;
};

export function templateValuesFrom(body: Record<string, unknown>): TemplateValues {
  return {
    role: text(body, 'role'),
    weekday: text(body, 'weekday'),
    start: clock(text(body, 'start')),
    end: clock(text(body, 'end')),
    capacity: text(body, 'capacity'),
    startsOn: text(body, 'startsOn'),
    endsOn: text(body, 'endsOn'),
  };
}

export function parseTemplate(values: TemplateValues): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  const role = values.role.trim();
  if (role.length === 0) return { ok: false, error: 'Enter a role.' };
  if (role.length > 80) return { ok: false, error: 'Use a shorter role.' };
  if (!/^[0-6]$/.test(values.weekday)) return { ok: false, error: 'Choose a day.' };
  try {
    assertSameDayShift(values.start, values.end);
  } catch (err) {
    if (err instanceof LocalTimeError) return { ok: false, error: err.message };
    throw err;
  }
  if (!calendarDate(values.startsOn)) return { ok: false, error: 'Enter the first date.' };
  const endsOn = values.endsOn.trim();
  if (endsOn.length > 0 && !calendarDate(endsOn)) return { ok: false, error: 'Enter an end date, or leave it blank.' };
  if (endsOn.length > 0 && endsOn < values.startsOn) {
    return { ok: false, error: 'The end date must be on or after the first date.' };
  }
  if (!/^[1-9][0-9]*$/.test(values.capacity)) return { ok: false, error: 'Enter a capacity of at least 1.' };
  const capacity = Number(values.capacity);
  if (!Number.isSafeInteger(capacity) || capacity > 500) return { ok: false, error: 'Capacity cannot be more than 500.' };
  return {
    ok: true,
    value: {
      role,
      weekday: Number(values.weekday),
      start: values.start,
      end: values.end,
      capacity,
      startsOn: values.startsOn,
      endsOn: endsOn.length > 0 ? endsOn : null,
    },
  };
}

export function normalizeSlug(input: string): string {
  return input
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function validSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function clock(value: string): string {
  return /^([01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/.test(value) ? value.slice(0, 5) : value;
}
