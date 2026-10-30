import type Database from 'better-sqlite3';
import { writeAudit } from './auth/audit.js';
import { normalizeEmail } from './email.js';

/** Earlier reminder, then the closer one. Used when the coordinator has not saved a pair. */
export const DEFAULT_REMINDER_HOURS = [48, 2] as const;
export const DEFAULT_RETENTION_MONTHS = 24;
export const MAX_REMINDER_HOURS = 336;
export const MAX_RETENTION_MONTHS = 120;

const HOUR_KEY = 'reminder_hours';
const REPLY_KEY = 'reply_to';
const RETENTION_KEY = 'retention_months';

export type PantrySettings = {
  /** Larger hour count first, so the first reminder is the earlier one. */
  reminderHours: readonly [number, number];
  replyTo: string;
  retentionMonths: number;
};

export type SettingsForm = {
  reminderFar: string;
  reminderNear: string;
  replyTo: string;
  retentionMonths: string;
};

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

export function readRetentionMonths(db: Database.Database): number {
  return storedRetention(db);
}

export function readPantrySettings(db: Database.Database, fallbackReplyTo: string): PantrySettings {
  return {
    reminderHours: storedHours(db),
    replyTo: storedReplyTo(db) ?? fallbackReplyTo,
    retentionMonths: storedRetention(db),
  };
}

/** Closest offset is first, so a late catch-up keeps the reminder nearest the shift. */
export function readReminderOffsets(db: Database.Database): { kind: string; hours: number }[] {
  const [earlier, closer] = storedHours(db);
  return [
    { kind: `${closer}h`, hours: closer },
    { kind: `${earlier}h`, hours: earlier },
  ];
}

export function readReplyTo(db: Database.Database, fallback: string): string {
  return storedReplyTo(db) ?? fallback;
}

export function settingsFormFrom(settings: PantrySettings): SettingsForm {
  return {
    reminderFar: String(settings.reminderHours[0]),
    reminderNear: String(settings.reminderHours[1]),
    replyTo: settings.replyTo,
    retentionMonths: String(settings.retentionMonths),
  };
}

export function parseSettingsForm(input: SettingsForm): { ok: true; value: PantrySettings } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const earlier = parseHour(input.reminderFar);
  const closer = parseHour(input.reminderNear);
  if (earlier === null) errors.reminderFar = 'Choose when the first reminder goes out.';
  if (closer === null) errors.reminderNear = 'Choose when the second reminder goes out.';
  if (earlier !== null && closer !== null && earlier === closer) {
    errors.reminderNear = 'Choose two different times.';
  }
  const reply = parseReply(input.replyTo);
  if (!reply.ok) errors.replyTo = reply.error;
  const months = parseMonths(input.retentionMonths);
  if (months === null) errors.retentionMonths = 'Choose how long to keep signup details.';
  if (earlier === null || closer === null || earlier === closer || !reply.ok || months === null) {
    return { ok: false, errors };
  }
  const reminderHours: [number, number] = earlier > closer ? [earlier, closer] : [closer, earlier];
  return {
    ok: true,
    value: {
      reminderHours,
      replyTo: reply.value,
      retentionMonths: months,
    },
  };
}

/**
 * Saves reminder times, the reply address, and how long signup details are kept.
 * This does not remove signup details, and it does not change mail that is already queued.
 */
export function savePantrySettings(
  db: Database.Database,
  coordinatorId: number,
  next: PantrySettings,
  fallbackReplyTo: string,
  now: string,
): { changed: boolean } {
  db.prepare(`DELETE FROM settings WHERE key = 'privacy_text'`).run();
  const current = readPantrySettings(db, fallbackReplyTo);
  const replyChanged = current.replyTo !== next.replyTo;
  const hoursChanged = current.reminderHours[0] !== next.reminderHours[0] || current.reminderHours[1] !== next.reminderHours[1];
  const retentionChanged = current.retentionMonths !== next.retentionMonths;
  if (!replyChanged && !hoursChanged && !retentionChanged) return { changed: false };
  db.transaction(() => {
    writeValue(db, HOUR_KEY, [next.reminderHours[0], next.reminderHours[1]], now);
    writeValue(db, REPLY_KEY, next.replyTo, now);
    writeValue(db, RETENTION_KEY, next.retentionMonths, now);
    writeAudit(
      db,
      coordinatorId,
      'settings.update',
      {
        reminderEarlier: next.reminderHours[0],
        reminderCloser: next.reminderHours[1],
        retentionMonths: next.retentionMonths,
        replyChanged: replyChanged ? 1 : 0,
      },
      now,
    );
  }).immediate();
  return { changed: true };
}

function storedHours(db: Database.Database): readonly [number, number] {
  const value = readValue(db, HOUR_KEY);
  if (!Array.isArray(value) || value.length !== 2) return DEFAULT_REMINDER_HOURS;
  const first = value[0];
  const second = value[1];
  if (!isHour(first) || !isHour(second) || first === second) return DEFAULT_REMINDER_HOURS;
  return first > second ? [first, second] : [second, first];
}

function storedReplyTo(db: Database.Database): string | null {
  const value = readValue(db, REPLY_KEY);
  if (typeof value !== 'string') return null;
  try {
    return normalizeEmail(value);
  } catch {
    return null;
  }
}

function storedRetention(db: Database.Database): number {
  const value = readValue(db, RETENTION_KEY);
  return isMonth(value) ? value : DEFAULT_RETENTION_MONTHS;
}

function readValue(db: Database.Database, key: string): unknown {
  const row = db.prepare('SELECT value_json AS value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return undefined;
  }
}

function writeValue(db: Database.Database, key: string, value: unknown, now: string): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

function parseHour(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return isHour(hours) ? hours : null;
}

function parseMonths(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(trimmed)) return null;
  const months = Number(trimmed);
  return isMonth(months) ? months : null;
}

function parseReply(value: string): { ok: true; value: string } | { ok: false; error: string } {
  if (value.includes('<') || value.includes('>')) {
    return { ok: false, error: 'Enter just the email address, without a name in front of it.' };
  }
  try {
    return { ok: true, value: normalizeEmail(value) };
  } catch {
    return { ok: false, error: 'Enter an email address.' };
  }
}

function isHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_REMINDER_HOURS;
}

function isMonth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_RETENTION_MONTHS;
}
