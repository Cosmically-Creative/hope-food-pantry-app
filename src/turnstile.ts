import { isTurnstileTestKey } from './config.js';

export type TurnstileVerdict = { ok: true } | { ok: false; reason: 'rejected' | 'duplicate' | 'unavailable' };

export type TurnstileCheck = {
  secret: string;
  token: string;
  remoteIp: string;
  expectedHostname: string;
  expectedAction: string;
  fetchImpl?: typeof fetch;
};

/**
 * Server-side Turnstile check. A spent token is not sent again.
 * Network failure and an unexpected hostname or action fail closed.
 */
export async function verifyTurnstile(input: TurnstileCheck): Promise<TurnstileVerdict> {
  const body = new URLSearchParams({
    secret: input.secret,
    response: input.token,
    remoteip: input.remoteIp,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) return { ok: false, reason: 'unavailable' };
  let payload: SiteverifyResponse;
  try {
    payload = (await response.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (payload.success !== true) {
    const codes = payload['error-codes'] ?? [];
    if (codes.includes('timeout-or-duplicate')) return { ok: false, reason: 'duplicate' };
    return { ok: false, reason: 'rejected' };
  }
  // Cloudflare's documented test keys succeed with hostname example.com and no action.
  if (payload.metadata?.result_with_testing_key === true && isTurnstileTestKey(input.secret)) {
    return { ok: true };
  }
  if (payload.hostname !== input.expectedHostname) return { ok: false, reason: 'rejected' };
  if (payload.action !== input.expectedAction) return { ok: false, reason: 'rejected' };
  return { ok: true };
}

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
  metadata?: { result_with_testing_key?: boolean };
};
