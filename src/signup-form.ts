import { z } from 'zod';
import { EmailAddressError, normalizeEmail } from './email.js';
import { capitalizeName, formatPhone } from './person-format.js';

const NAME_MAX = 80;
const PHONE_MAX = 40;
const NOTES_MAX = 500;

/** One signup can hold this many spots. The database check uses the same bound. */
export const MAX_PARTY_SIZE = 20;

export type SignupValues = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
  partySize: string;
};

export type SignupErrors = Partial<
  Record<'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'notes' | 'partySize' | 'form', string>
>;

export type SignupDraft = {
  name: string;
  email: string;
  emailNorm: string;
  phone: string;
  notes: string | null;
  groupSize: number;
};

export const EMPTY_SIGNUP: SignupValues = {
  name: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  notes: '',
  partySize: '1',
};

/** Choices for the people control. Never offers more than the spots still open, or more than the stored maximum. */
export function partyChoices(remaining: number): number[] {
  const room = Math.max(0, Math.floor(remaining));
  const cap = Math.min(MAX_PARTY_SIZE, room);
  return Array.from({ length: cap }, (_, index) => index + 1);
}

export function partyChoiceLabel(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

export function spotsLeftMessage(remaining: number): string {
  return remaining === 1 ? 'This shift has 1 spot left.' : `This shift has ${remaining} spots left.`;
}

const controlChars = /[\u0000-\u001F\u007F]/;

function personPart(raw: string, label: string): { value: string; error?: string } {
  const trimmed = raw.normalize('NFC').trim();
  const value = capitalizeName(trimmed);
  if (trimmed.length === 0 || value.length === 0) return { value: '', error: `Enter your ${label}.` };
  if (trimmed.length > NAME_MAX || value.length > NAME_MAX) return { value, error: `Use ${NAME_MAX} characters or fewer.` };
  if (controlChars.test(trimmed)) return { value, error: `Enter your ${label} without line breaks.` };
  return { value };
}

export function parseSignupForm(
  input: SignupValues,
  voice: 'volunteer' | 'coordinator' = 'volunteer',
): { ok: true; draft: SignupDraft } | { ok: false; errors: SignupErrors } {
  const parsed = z
    .object({
      name: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      phone: z.string(),
      notes: z.string(),
      partySize: z.string(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, errors: { form: 'Check the signup fields and try again.' } };
  const errors: SignupErrors = {};
  let name = '';
  if (voice === 'coordinator') {
    const nameRaw = parsed.data.name.normalize('NFC').trim();
    name = capitalizeName(nameRaw);
    if (nameRaw.length === 0 || name.length === 0) errors.name = 'Enter their name.';
    else if (nameRaw.length > NAME_MAX || name.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
    else if (controlChars.test(nameRaw)) errors.name = 'Enter their name without line breaks.';
  } else {
    const first = personPart(parsed.data.firstName, 'first name');
    const last = personPart(parsed.data.lastName, 'last name');
    if (first.error) errors.firstName = first.error;
    if (last.error) errors.lastName = last.error;
    if (!first.error && !last.error && `${first.value} ${last.value}`.length > NAME_MAX) {
      errors.lastName = `Use ${NAME_MAX} characters or fewer for the full name.`;
    }
    name = first.error || last.error || errors.lastName ? '' : `${first.value} ${last.value}`;
  }

  let emailNorm = '';
  try {
    emailNorm = normalizeEmail(parsed.data.email);
  } catch (err) {
    errors.email = err instanceof EmailAddressError ? err.message : 'Enter an email address.';
  }

  const phoneRaw = parsed.data.phone.normalize('NFC').trim();
  const phone = phoneRaw.length === 0 ? '' : formatPhone(phoneRaw);
  if (phoneRaw.length === 0 || phone.length === 0) {
    errors.phone = voice === 'coordinator' ? 'Enter their phone number.' : 'Enter your phone number.';
  } else if (phoneRaw.length > PHONE_MAX || phone.length > PHONE_MAX) errors.phone = `Use ${PHONE_MAX} characters or fewer.`;
  else if (controlChars.test(phoneRaw)) errors.phone = 'Enter a phone number without line breaks.';

  const notes = parsed.data.notes.normalize('NFC').trim();
  if (notes.length > NOTES_MAX) errors.notes = `Use ${NOTES_MAX} characters or fewer.`;
  else if (controlChars.test(notes)) errors.notes = 'Enter notes without control characters.';

  const party = readPartySize(parsed.data.partySize, voice);
  if (party.error) errors.partySize = party.error;

  if (Object.keys(errors).length > 0 || emailNorm.length === 0 || phone.length === 0 || party.error) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    draft: {
      name,
      email: emailNorm,
      emailNorm,
      phone,
      notes: notes.length === 0 ? null : notes,
      groupSize: party.value,
    },
  };
}

function readPartySize(raw: string, voice: 'volunteer' | 'coordinator'): { value: number; error?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: 1 };
  const label = voice === 'coordinator' ? 'Choose how many people are here.' : 'Choose how many people are coming.';
  if (!/^[1-9]\d*$/.test(trimmed)) return { value: 1, error: label };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PARTY_SIZE) {
    return { value: 1, error: `Choose ${MAX_PARTY_SIZE} people or fewer.` };
  }
  return { value };
}
