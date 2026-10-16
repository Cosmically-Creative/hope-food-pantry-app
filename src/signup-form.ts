import { z } from 'zod';
import { EmailAddressError, normalizeEmail } from './email.js';

const NAME_MAX = 80;
const PHONE_MAX = 40;
const NOTES_MAX = 500;

export type SignupValues = {
  name: string;
  email: string;
  phone: string;
  notes: string;
  under18: boolean;
  guardianName: string;
  guardianEmail: string;
};

export type SignupErrors = Partial<Record<'name' | 'email' | 'phone' | 'notes' | 'guardianName' | 'guardianEmail' | 'form', string>>;

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
  email: '',
  phone: '',
  notes: '',
  under18: false,
  guardianName: '',
  guardianEmail: '',
};

const controlChars = /[\u0000-\u001F\u007F]/;

export function parseSignupForm(
  input: SignupValues,
  voice: 'volunteer' | 'coordinator' = 'volunteer',
): { ok: true; draft: SignupDraft } | { ok: false; errors: SignupErrors } {
  const parsed = z
    .object({
      name: z.string(),
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
  const name = parsed.data.name.normalize('NFC').trim();
  const nameLabel = voice === 'coordinator' ? 'their name' : 'your name';
  if (name.length === 0) errors.name = `Enter ${nameLabel}.`;
  else if (name.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
  else if (controlChars.test(name)) errors.name = `Enter ${nameLabel} without line breaks.`;

  let emailNorm = '';
  try {
    emailNorm = normalizeEmail(parsed.data.email);
  } catch (err) {
    errors.email = err instanceof EmailAddressError ? err.message : 'Enter an email address.';
  }

  const phone = parsed.data.phone.normalize('NFC').trim();
  if (phone.length > PHONE_MAX) errors.phone = `Use ${PHONE_MAX} characters or fewer.`;
  else if (controlChars.test(phone)) errors.phone = 'Enter a phone number without line breaks.';

  const notes = parsed.data.notes.normalize('NFC').trim();
  if (notes.length > NOTES_MAX) errors.notes = `Use ${NOTES_MAX} characters or fewer.`;
  else if (controlChars.test(notes)) errors.notes = 'Enter notes without control characters.';

  let guardianName: string | null = null;
  let guardianEmail: string | null = null;
  let guardianEmailNorm: string | null = null;
  if (parsed.data.under18) {
    guardianName = parsed.data.guardianName.normalize('NFC').trim();
    if (guardianName.length === 0) errors.guardianName = 'Enter the guardian name.';
    else if (guardianName.length > NAME_MAX) errors.guardianName = `Use ${NAME_MAX} characters or fewer.`;
    else if (controlChars.test(guardianName)) errors.guardianName = 'Enter the guardian name without line breaks.';
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
