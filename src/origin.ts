import type { Context } from 'hono';

/**
 * A form POST must come from this site.
 * Origin: null is an opaque origin, not a match for BASE_URL.
 * Sec-Fetch-Site is set by the browser. same-origin and none are not cross-site forgery.
 */
export function originAllowed(c: Context, baseUrl: string): boolean {
  const origin = c.req.header('origin');
  if (origin && origin !== 'null') return origin === baseUrl;
  const site = c.req.header('sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return true;
  const referer = c.req.header('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === baseUrl;
  } catch {
    return false;
  }
}
