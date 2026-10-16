import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Supplemental bot signal. Not authentication. */
export const MIN_FILL_MS = 3000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;

export type FormClaims = {
  shiftId: number;
  issuedAt: number;
  operationId: string;
};

export type FormTokenResult =
  | { ok: true; claims: FormClaims }
  | { ok: false; reason: 'invalid' | 'too_fast' | 'expired' };

export function newOperationId(): string {
  return randomBytes(16).toString('base64url');
}

export function issueFormToken(secret: string, claims: FormClaims): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      shiftId: claims.shiftId,
      issuedAt: claims.issuedAt,
      operationId: claims.operationId,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function readFormToken(
  secret: string,
  token: string,
  shiftId: number,
  nowMs: number,
  minFillMs = MIN_FILL_MS,
): FormTokenResult {
  const opened = openFormToken(secret, token, nowMs, minFillMs);
  if (!opened.ok) return opened;
  if (opened.claims.shiftId !== shiftId) return { ok: false, reason: 'invalid' };
  return opened;
}

export function openFormToken(secret: string, token: string, nowMs: number, minFillMs = MIN_FILL_MS): FormTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid' };
  const payload = parts[0];
  const signature = parts[1];
  if (!payload || !signature || !safeEqual(sign(secret, payload), signature)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isClaims(parsed)) return { ok: false, reason: 'invalid' };
  if (parsed.issuedAt > nowMs + CLOCK_SKEW_MS) return { ok: false, reason: 'invalid' };
  const age = nowMs - parsed.issuedAt;
  if (age < minFillMs) return { ok: false, reason: 'too_fast' };
  if (age > MAX_AGE_MS) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    claims: { shiftId: parsed.shiftId, issuedAt: parsed.issuedAt, operationId: parsed.operationId },
  };
}

function isClaims(value: unknown): value is FormClaims & { v: 1 } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.shiftId === 'number' &&
    Number.isSafeInteger(record.shiftId) &&
    record.shiftId > 0 &&
    typeof record.issuedAt === 'number' &&
    Number.isSafeInteger(record.issuedAt) &&
    typeof record.operationId === 'string' &&
    /^[A-Za-z0-9_-]{16,80}$/.test(record.operationId)
  );
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
