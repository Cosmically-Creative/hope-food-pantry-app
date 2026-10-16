import type { MiddlewareHandler } from 'hono';

/**
 * Baseline from the October 14, 2026 specification.
 * Signup pages load the Turnstile script in a frame. The widget also connects
 * to that same host. Do not widen this to a wildcard or unsafe-inline.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "connect-src 'self' https://challenges.cloudflare.com",
  "img-src 'self' data:",
  "style-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/** The app uses no device features. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/** One year, this host only. Other pantry subdomains are not covered. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

/** HSTS is sent only when BASE_URL is https. A browser ignores it over http. */
export function securityHeaders(options: { https: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Permissions-Policy', PERMISSIONS_POLICY);
    if (options.https) c.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  };
}
