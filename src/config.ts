import path from 'node:path';
import { z } from 'zod';
import { parseTrustProxy, type TrustProxy } from './client-ip.js';
import { EmailAddressError, normalizeEmail } from './email.js';
import { assertValidTimeZone, LocalTimeError } from './time.js';

/**
 * All configuration is read here. Production refuses Cloudflare test keys,
 * console mail, non-https origins, and weak session secrets.
 */

export const DATABASE_FILENAME = 'app.db';

/** Documented Cloudflare Turnstile test keys. Development and test only. */
export const TURNSTILE_TEST_SITE_KEYS = [
  '1x00000000000000000000AA',
  '1x00000000000000000000BB',
  '2x00000000000000000000AB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
] as const;

export const TURNSTILE_TEST_SECRET_KEYS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
] as const;

const TEST_KEY_PATTERN = /^[123]x0{10,}[0-9a-z]*$/i;
const WEAK_SECRET_MARKERS = [
  'change-me',
  'changeme',
  'password',
  'secret',
  'placeholder',
  'dev-only',
  'qwerty',
  'letmein',
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type MailDriver = 'console' | 'smtp2go' | 'postmark' | 'ses';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  baseUrl: string;
  basePath: string;
  dataDir: string;
  databaseFile: string;
  sessionSecret: string;
  secureCookies: boolean;
  defaultTimeZone: string;
  mail: {
    driver: MailDriver;
    from: string;
    replyTo: string;
    smtp2goApiKey: string | null;
    postmarkToken: string | null;
    ses: { region: string; accessKeyId: string; secretAccessKey: string } | null;
  };
  turnstile: { siteKey: string; secretKey: string };
  brandSrc: string;
  bootstrapAdminEmail: string;
  trustProxy: TrustProxy;
  /** 127.0.0.1 for local development. 0.0.0.0 inside Docker so the published localhost port can connect. */
  bindHost: '127.0.0.1' | '0.0.0.0';
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    errorMap: () => ({ message: 'NODE_ENV must be development, test, or production.' }),
  }),
  PORT: z.string().regex(/^[0-9]+$/, 'PORT must be a whole number.'),
  BASE_URL: z.string().min(1, 'BASE_URL is required.'),
  BASE_PATH: z.string(),
  DATA_DIR: z.string().min(1, 'DATA_DIR is required.'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters.'),
  DEFAULT_TZ: z.string().min(1, 'DEFAULT_TZ is required.'),
  MAIL_DRIVER: z.enum(['console', 'smtp2go', 'postmark', 'ses'], {
    errorMap: () => ({ message: 'MAIL_DRIVER must be console, smtp2go, postmark, or ses.' }),
  }),
  MAIL_FROM: z.string().min(1, 'MAIL_FROM is required.'),
  MAIL_REPLY_TO: z.string().min(1, 'MAIL_REPLY_TO is required.'),
  SMTP2GO_API_KEY: z.string(),
  POSTMARK_TOKEN: z.string(),
  SES_REGION: z.string(),
  SES_ACCESS_KEY_ID: z.string(),
  SES_SECRET_ACCESS_KEY: z.string(),
  TURNSTILE_SITE_KEY: z.string().min(1, 'TURNSTILE_SITE_KEY is required.'),
  TURNSTILE_SECRET_KEY: z.string().min(1, 'TURNSTILE_SECRET_KEY is required.'),
  BRAND_SRC: z.string().min(1, 'BRAND_SRC is required.'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().min(1, 'BOOTSTRAP_ADMIN_EMAIL is required.'),
  TRUST_PROXY: z.string(),
  BIND_HOST: z.string(),
});

export function isTurnstileTestKey(value: string): boolean {
  return (
    TURNSTILE_TEST_SITE_KEYS.some((key) => key === value) ||
    TURNSTILE_TEST_SECRET_KEYS.some((key) => key === value) ||
    TEST_KEY_PATTERN.test(value)
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse({
    NODE_ENV: blank(env.NODE_ENV),
    PORT: blank(env.PORT) ?? '3000',
    BASE_URL: blank(env.BASE_URL),
    BASE_PATH: (env.BASE_PATH ?? '').trim(),
    DATA_DIR: blank(env.DATA_DIR) ?? '/data',
    SESSION_SECRET: (env.SESSION_SECRET ?? '').trim(),
    DEFAULT_TZ: blank(env.DEFAULT_TZ) ?? 'America/Chicago',
    MAIL_DRIVER: blank(env.MAIL_DRIVER),
    MAIL_FROM: blank(env.MAIL_FROM),
    MAIL_REPLY_TO: blank(env.MAIL_REPLY_TO),
    SMTP2GO_API_KEY: (env.SMTP2GO_API_KEY ?? '').trim(),
    POSTMARK_TOKEN: (env.POSTMARK_TOKEN ?? '').trim(),
    SES_REGION: (env.SES_REGION ?? '').trim(),
    SES_ACCESS_KEY_ID: (env.SES_ACCESS_KEY_ID ?? '').trim(),
    SES_SECRET_ACCESS_KEY: (env.SES_SECRET_ACCESS_KEY ?? '').trim(),
    TURNSTILE_SITE_KEY: blank(env.TURNSTILE_SITE_KEY),
    TURNSTILE_SECRET_KEY: blank(env.TURNSTILE_SECRET_KEY),
    BRAND_SRC: blank(env.BRAND_SRC) ?? '../Hope Food Pantry Website/brand',
    BOOTSTRAP_ADMIN_EMAIL: blank(env.BOOTSTRAP_ADMIN_EMAIL),
    TRUST_PROXY: blank(env.TRUST_PROXY) ?? 'false',
    BIND_HOST: blank(env.BIND_HOST) ?? '127.0.0.1',
  });
  if (!parsed.success) {
    throw new ConfigError(formatProblems(parsed.error.issues.map((issue) => issue.message)));
  }
  const input = parsed.data;
  const problems: string[] = [];
  const port = Number(input.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('PORT must be from 1 through 65535.');
  }
  const baseUrl = normalizeBaseUrl(input.BASE_URL, input.NODE_ENV, problems);
  const basePath = normalizeBasePath(input.BASE_PATH, problems);
  const dataDir = path.resolve(input.DATA_DIR);
  if (dataDir === path.parse(dataDir).root) {
    problems.push('DATA_DIR must be a directory for this app, not the filesystem root.');
  }
  let defaultTimeZone = input.DEFAULT_TZ;
  try {
    defaultTimeZone = assertValidTimeZone(input.DEFAULT_TZ);
  } catch (err) {
    problems.push(err instanceof LocalTimeError ? err.message : 'DEFAULT_TZ is not a recognized IANA time zone.');
  }
  const sessionProblems = sessionSecretProblems(input.SESSION_SECRET, input.NODE_ENV);
  problems.push(...sessionProblems);
  const from = parseFrom(input.MAIL_FROM, problems);
  const replyTo = parseReplyTo(input.MAIL_REPLY_TO, problems);
  const mail = resolveMail(input, problems);
  // TODO(D5): Production must use the real Turnstile keys for the public hostname.
  if (input.NODE_ENV === 'production' && isTurnstileTestKey(input.TURNSTILE_SITE_KEY)) {
    problems.push('TURNSTILE_SITE_KEY is a Cloudflare test key. Production requires the real site key for the pantry hostname.');
  }
  if (input.NODE_ENV === 'production' && isTurnstileTestKey(input.TURNSTILE_SECRET_KEY)) {
    problems.push('TURNSTILE_SECRET_KEY is a Cloudflare test key. Production requires the real secret key for the pantry hostname.');
  }
  if (input.TURNSTILE_SITE_KEY.length < 20 || input.TURNSTILE_SECRET_KEY.length < 20) {
    problems.push('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY do not look like Turnstile keys.');
  }
  let bootstrapAdminEmail = '';
  try {
    // TODO(D4): Validated only. This step does not create the administrator account.
    bootstrapAdminEmail = normalizeEmail(input.BOOTSTRAP_ADMIN_EMAIL);
  } catch (err) {
    problems.push(err instanceof EmailAddressError ? 'BOOTSTRAP_ADMIN_EMAIL must be an email address.' : 'BOOTSTRAP_ADMIN_EMAIL is invalid.');
  }
  let trustProxy: TrustProxy = { mode: 'disabled' };
  try {
    trustProxy = parseTrustProxy(input.TRUST_PROXY);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : 'TRUST_PROXY is invalid.');
  }
  if (input.BIND_HOST !== '127.0.0.1' && input.BIND_HOST !== '0.0.0.0') {
    problems.push('BIND_HOST must be 127.0.0.1 or 0.0.0.0.');
  }
  if (problems.length > 0 || !baseUrl || basePath === null || !from || !replyTo || !mail) {
    throw new ConfigError(formatProblems(problems));
  }
  return {
    nodeEnv: input.NODE_ENV,
    port,
    baseUrl: baseUrl.origin,
    basePath,
    dataDir,
    databaseFile: path.join(dataDir, DATABASE_FILENAME),
    sessionSecret: input.SESSION_SECRET,
    secureCookies: baseUrl.secure,
    defaultTimeZone,
    mail: {
      driver: input.MAIL_DRIVER,
      from,
      replyTo,
      smtp2goApiKey: mail.smtp2goApiKey,
      postmarkToken: mail.postmarkToken,
      ses: mail.ses,
    },
    turnstile: {
      siteKey: input.TURNSTILE_SITE_KEY,
      secretKey: input.TURNSTILE_SECRET_KEY,
    },
    brandSrc: input.BRAND_SRC,
    bootstrapAdminEmail,
    trustProxy,
    bindHost: input.BIND_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
  };
}

function normalizeBaseUrl(
  value: string,
  nodeEnv: 'development' | 'test' | 'production',
  problems: string[],
): { origin: string; secure: boolean } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push('BASE_URL must be an absolute origin, such as http://127.0.0.1:3000 or https://example.org.');
    return null;
  }
  if (url.username || url.password) problems.push('BASE_URL must not include a username or password.');
  if (url.search || url.hash) problems.push('BASE_URL must not include a query or hash.');
  if (url.pathname !== '/' && url.pathname !== '') {
    problems.push('BASE_URL is the public origin only. Put a mount prefix such as /volunteer in BASE_PATH.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push('BASE_URL must start with http:// or https://.');
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (nodeEnv === 'production') {
    if (url.protocol !== 'https:') problems.push('Production BASE_URL must use https.');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') || !host.includes('.')) {
      problems.push('Production BASE_URL must be the public hostname, not a local address.');
    }
  }
  return { origin: url.origin, secure: url.protocol === 'https:' };
}

function normalizeBasePath(input: string, problems: string[]): string | null {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '/') return '';
  let value = trimmed;
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (!value.startsWith('/')) {
    problems.push('BASE_PATH must start with /, or be empty.');
    return null;
  }
  if (value.includes('//') || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('..')) {
    problems.push('BASE_PATH must be a simple prefix such as /volunteer.');
    return null;
  }
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/.test(value)) {
    problems.push('BASE_PATH must be a simple prefix such as /volunteer.');
    return null;
  }
  return value;
}

function sessionSecretProblems(secret: string, nodeEnv: 'development' | 'test' | 'production'): string[] {
  if (nodeEnv !== 'production') return [];
  const problems: string[] = [];
  const lower = secret.toLowerCase();
  if (WEAK_SECRET_MARKERS.some((marker) => lower.includes(marker))) {
    problems.push(
      'SESSION_SECRET looks like a placeholder. Generate a random one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  if (new Set(secret).size < 16) {
    problems.push('SESSION_SECRET does not look random enough for production.');
  }
  return problems;
}

function parseFrom(value: string, problems: string[]): string | null {
  if (/[\r\n]/.test(value)) {
    problems.push('MAIL_FROM must not contain a line break.');
    return null;
  }
  const named = /^(.*?)<\s*([^>]+)\s*>\s*$/.exec(value.trim());
  try {
    if (!named) return normalizeEmail(value);
    const display = (named[1] ?? '').trim().replace(/^"|"$/g, '');
    const address = normalizeEmail(named[2] ?? '');
    if (/[<>]/.test(display)) {
      problems.push('MAIL_FROM has an invalid display name.');
      return null;
    }
    return display === '' ? address : `${display} <${address}>`;
  } catch {
    problems.push('MAIL_FROM must be an email address, or a name and address such as Hope Food Pantry <volunteer@example.org>.');
    return null;
  }
}

function parseReplyTo(value: string, problems: string[]): string | null {
  if (value.includes('<') || value.includes('>')) {
    problems.push('MAIL_REPLY_TO must be an email address without a display name.');
    return null;
  }
  try {
    return normalizeEmail(value);
  } catch {
    problems.push('MAIL_REPLY_TO must be an email address.');
    return null;
  }
}

function resolveMail(
  input: z.infer<typeof schema>,
  problems: string[],
): { smtp2goApiKey: string | null; postmarkToken: string | null; ses: AppConfig['mail']['ses'] } | null {
  // TODO(D1): SMTP2GO is the provider. Verify the sender and reply-to before real mail is enabled.
  if (input.NODE_ENV === 'production' && input.MAIL_DRIVER === 'console') {
    problems.push('MAIL_DRIVER=console is only for development. Use smtp2go after the sender address is verified with SMTP2GO.');
  }
  if (input.MAIL_DRIVER === 'smtp2go') {
    const apiKey = requireCredential(input.SMTP2GO_API_KEY, 'SMTP2GO_API_KEY', problems);
    if (!apiKey) return null;
    return { smtp2goApiKey: apiKey, postmarkToken: null, ses: null };
  }
  if (input.MAIL_DRIVER === 'postmark') {
    const token = requireCredential(input.POSTMARK_TOKEN, 'POSTMARK_TOKEN', problems);
    if (!token) return null;
    return { smtp2goApiKey: null, postmarkToken: token, ses: null };
  }
  if (input.MAIL_DRIVER === 'ses') {
    if (!/^[a-z]{2}-[a-z]+-\d+$/.test(input.SES_REGION)) {
      problems.push('SES_REGION must look like us-east-1.');
    }
    const accessKeyId = requireCredential(input.SES_ACCESS_KEY_ID, 'SES_ACCESS_KEY_ID', problems);
    const secretAccessKey = requireCredential(input.SES_SECRET_ACCESS_KEY, 'SES_SECRET_ACCESS_KEY', problems);
    if (!accessKeyId || !secretAccessKey || !/^[a-z]{2}-[a-z]+-\d+$/.test(input.SES_REGION)) return null;
    return {
      smtp2goApiKey: null,
      postmarkToken: null,
      ses: { region: input.SES_REGION, accessKeyId, secretAccessKey },
    };
  }
  return { smtp2goApiKey: null, postmarkToken: null, ses: null };
}

function requireCredential(value: string, label: string, problems: string[]): string | null {
  if (value === '') {
    problems.push(`${label} is required for the selected mail driver.`);
    return null;
  }
  if (/^(change-me|changeme|placeholder|secret|token|password|example)$/i.test(value)) {
    problems.push(`${label} is still a placeholder.`);
    return null;
  }
  if (value.length < 16) {
    problems.push(`${label} is too short.`);
    return null;
  }
  return value;
}

function formatProblems(problems: string[]): string {
  const unique = [...new Set(problems.filter((problem) => problem.trim() !== ''))];
  return `Configuration is invalid:\n- ${unique.join('\n- ')}`;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
