import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const COOKIE = 'hope_confirm';
const MAX_AGE_SECONDS = 900;

export type ConfirmationSeal = {
  signupId: number;
  shiftId: number;
  token: string;
  expiresAtMs: number;
};

export function sealConfirmation(secret: string, payload: ConfirmationSeal): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function openConfirmation(secret: string, cookieHeader: string | undefined, nowMs: number): ConfirmationSeal | null {
  const raw = readCookie(cookieHeader, COOKIE);
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.length < 12 + 16 + 2) return null;
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const ciphertext = bytes.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(secret), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json) as Partial<ConfirmationSeal>;
    if (!parsed || typeof parsed.signupId !== 'number' || typeof parsed.shiftId !== 'number') return null;
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAtMs !== 'number') return null;
    if (parsed.expiresAtMs <= nowMs) return null;
    return {
      signupId: parsed.signupId,
      shiftId: parsed.shiftId,
      token: parsed.token,
      expiresAtMs: parsed.expiresAtMs,
    };
  } catch {
    return null;
  }
}

export function confirmationCookie(value: string, path: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${path}`,
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function cookieKey(secret: string): Buffer {
  return createHash('sha256').update(`hope-confirm-v1\0${secret}`).digest();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}
