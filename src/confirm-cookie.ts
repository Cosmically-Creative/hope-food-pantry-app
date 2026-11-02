import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const COOKIE = 'hope_confirm';
const MAX_AGE_SECONDS = 900;

export type ConfirmationCompanion = {
  signupId: number;
  shiftId: number;
  token: string;
};

export type ConfirmationSeal = {
  signupId: number;
  shiftId: number;
  token: string;
  expiresAtMs: number;
  companions?: ConfirmationCompanion[];
};

export function sealConfirmation(secret: string, payload: ConfirmationSeal): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(secret), iv);
  const stored = {
    signupId: payload.signupId,
    shiftId: payload.shiftId,
    token: payload.token,
    expiresAtMs: payload.expiresAtMs,
    ...(payload.companions && payload.companions.length > 0 ? { companions: payload.companions } : {}),
  };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(stored), 'utf8'), cipher.final()]);
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
    const companions = readCompanions(parsed.companions);
    if (!companions) return null;
    return {
      signupId: parsed.signupId,
      shiftId: parsed.shiftId,
      token: parsed.token,
      expiresAtMs: parsed.expiresAtMs,
      ...(companions.length > 0 ? { companions } : {}),
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

function readCompanions(value: unknown): ConfirmationCompanion[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) return null;
  const companions: ConfirmationCompanion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (typeof record.signupId !== 'number' || !Number.isSafeInteger(record.signupId) || record.signupId <= 0) return null;
    if (typeof record.shiftId !== 'number' || !Number.isSafeInteger(record.shiftId) || record.shiftId <= 0) return null;
    if (typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(record.token)) return null;
    companions.push({ signupId: record.signupId, shiftId: record.shiftId, token: record.token });
  }
  return companions;
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
