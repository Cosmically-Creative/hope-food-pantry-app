import { z } from 'zod';
import { EmailAddressError, normalizeEmail } from './email.js';
import { capitalizeName, formatPhone } from './person-format.js';

const NAME_MAX = 80;
const PHONE_MAX = 40;
const NOTES_MAX = 500;

export type SignupValues = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
  under18: boolean;
  guardianName: string;
  guardianEmail: string;
};

export type SignupErrors = Partial<
  Record<'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'notes' | 'guardianName' | 'guardianEmail' | 'form', string>
>;

export type SignupDraft = {
  name: string;
  email: string;
  emailNorm: string;
  phone: string | null;
  notes: string | null;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianEmailNorm: string | null;
};

export const EMPTY_SIGNUP: SignupValues = {
  name: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  notes: '',
  under18: false,
  guardianName: '',
  guardianEmail: '',
};

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
      under18: z.boolean(),
      guardianName: z.string(),
      guardianEmail: z.string(),
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
  if (phoneRaw.length > PHONE_MAX || phone.length > PHONE_MAX) errors.phone = `Use ${PHONE_MAX} characters or fewer.`;
  else if (controlChars.test(phoneRaw)) errors.phone = 'Enter a phone number without line breaks.';

  const notes = parsed.data.notes.normalize('NFC').trim();
  if (notes.length > NOTES_MAX) errors.notes = `Use ${NOTES_MAX} characters or fewer.`;
  else if (controlChars.test(notes)) errors.notes = 'Enter notes without control characters.';

  let guardianName: string | null = null;
  let guardianEmail: string | null = null;
  let guardianEmailNorm: string | null = null;
  if (parsed.data.under18) {
    const guardianRaw = parsed.data.guardianName.normalize('NFC').trim();
    guardianName = capitalizeName(guardianRaw);
    if (guardianRaw.length === 0 || guardianName.length === 0) errors.guardianName = 'Enter the guardian name.';
    else if (guardianRaw.length > NAME_MAX || guardianName.length > NAME_MAX) errors.guardianName = `Use ${NAME_MAX} characters or fewer.`;
    else if (controlChars.test(guardianRaw)) errors.guardianName = 'Enter the guardian name without line breaks.';
    if (parsed.data.guardianEmail.trim() === '') {
      errors.guardianEmail = 'Enter the guardian email.';
    } else {
      try {
        guardianEmailNorm = normalizeEmail(parsed.data.guardianEmail);
        guardianEmail = guardianEmailNorm;
      } catch (err) {
        errors.guardianEmail = err instanceof EmailAddressError ? err.message : 'Enter the guardian email.';
      }
    }
  }

  if (Object.keys(errors).length > 0 || emailNorm.length === 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name,
      email: emailNorm,
      emailNorm,
      phone: phone.length === 0 ? null : phone,
      notes: notes.length === 0 ? null : notes,
      isMinor: parsed.data.under18,
      guardianName: parsed.data.under18 ? guardianName : null,
      guardianEmail: parsed.data.under18 ? guardianEmail : null,
      guardianEmailNorm: parsed.data.under18 ? guardianEmailNorm : null,
    },
  };
}
