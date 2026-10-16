import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTurnstileTestKey, loadConfig } from '../src/config.js';
import { devEnv, productionEnv } from './env.js';

const projectRoot = path.resolve(import.meta.dirname, '..');

describe('loadConfig', () => {
  it('accepts the development example shape', () => {
    const config = loadConfig(devEnv());
    expect(config.nodeEnv).toBe('development');
    expect(config.baseUrl).toBe('http://127.0.0.1:3000');
    expect(config.basePath).toBe('');
    expect(config.secureCookies).toBe(false);
    expect(config.mail.driver).toBe('console');
    expect(config.mail.from).toBe('Hope Food Pantry <volunteer@example.invalid>');
    expect(config.mail.replyTo).toBe('volunteer@example.invalid');
    expect(config.defaultTimeZone).toBe('America/Chicago');
    expect(config.trustProxy).toEqual({ mode: 'disabled' });
    expect(config.databaseFile.endsWith(`${path.sep}app.db`)).toBe(true);
  });

  it('normalizes a volunteer mount prefix', () => {
    const config = loadConfig(devEnv({ BASE_PATH: '/volunteer/' }));
    expect(config.basePath).toBe('/volunteer');
  });

  it('rejects a path on BASE_URL', () => {
    expect(() => loadConfig(devEnv({ BASE_URL: 'http://127.0.0.1:3000/volunteer' }))).toThrow(/BASE_PATH/);
  });

  it('rejects a prefix that does not start with a slash', () => {
    expect(() => loadConfig(devEnv({ BASE_PATH: 'volunteer' }))).toThrow(/BASE_PATH/);
  });

  it('rejects a prefix that climbs out of the mount', () => {
    expect(() => loadConfig(devEnv({ BASE_PATH: '/volunteer/../admin' }))).toThrow(/BASE_PATH/);
  });

  it('requires NODE_ENV', () => {
    const env = devEnv();
    delete env.NODE_ENV;
    expect(() => loadConfig(env)).toThrow(/NODE_ENV/);
  });

  it('rejects an unknown time zone', () => {
    expect(() => loadConfig(devEnv({ DEFAULT_TZ: 'Not/AZone' }))).toThrow(/time zone/i);
  });

  it('rejects a line break in the from address', () => {
    expect(() => loadConfig(devEnv({ MAIL_FROM: 'Hope\r\nBcc: x <a@example.invalid>' }))).toThrow(/MAIL_FROM/);
  });

  it('accepts a production configuration with real-looking keys', () => {
    const config = loadConfig(productionEnv('/tmp/hope-data'));
    expect(config.secureCookies).toBe(true);
    expect(config.mail.driver).toBe('postmark');
    expect(config.mail.postmarkToken).toBe('pm-server-token-9f3a2c1e5b8d4f70');
    expect(config.baseUrl).toBe('https://volunteer.example.org');
  });

  it('rejects console mail, test keys, http, and the example secret in production', () => {
    expect(() => loadConfig(productionEnv('/tmp/hope-data', { MAIL_DRIVER: 'console' }))).toThrow(/console/);
    expect(() =>
      loadConfig(productionEnv('/tmp/hope-data', { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })),
    ).toThrow(/test key/i);
    expect(() => loadConfig(productionEnv('/tmp/hope-data', { BASE_URL: 'http://volunteer.example.org' }))).toThrow(
      /https/,
    );
    expect(() =>
      loadConfig(
        productionEnv('/tmp/hope-data', { SESSION_SECRET: 'dev-only-change-me-not-for-production-use' }),
      ),
    ).toThrow(/SESSION_SECRET/);
    expect(() =>
      loadConfig(productionEnv('/tmp/hope-data', { SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })),
    ).toThrow(/random enough/);
  });

  it('requires credentials for the selected mail driver', () => {
    expect(() => loadConfig(devEnv({ MAIL_DRIVER: 'postmark', POSTMARK_TOKEN: '' }))).toThrow(/POSTMARK_TOKEN/);
    expect(() =>
      loadConfig(
        productionEnv('/tmp/hope-data', {
          MAIL_DRIVER: 'ses',
          SES_REGION: 'us-east-1',
          SES_ACCESS_KEY_ID: '',
          SES_SECRET_ACCESS_KEY: '',
        }),
      ),
    ).toThrow(/SES_ACCESS_KEY_ID/);
  });

  it('rejects TRUST_PROXY=true', () => {
    expect(() => loadConfig(devEnv({ TRUST_PROXY: 'true' }))).toThrow(/cannot be true/);
  });

  it('accepts a named proxy address', () => {
    const config = loadConfig(devEnv({ TRUST_PROXY: 'loopback, 172.18.0.1' }));
    expect(config.trustProxy.mode).toBe('list');
  });

  it('listens on localhost unless Docker asks for every interface', () => {
    expect(loadConfig(devEnv()).bindHost).toBe('127.0.0.1');
    expect(loadConfig(devEnv({ BIND_HOST: '0.0.0.0' })).bindHost).toBe('0.0.0.0');
    expect(() => loadConfig(devEnv({ BIND_HOST: '10.1.2.3' }))).toThrow(/BIND_HOST/);
  });

  it('loads .env.example as development and refuses that file for production', () => {
    const script = `console.log(JSON.stringify({
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      BASE_URL: process.env.BASE_URL,
      BASE_PATH: process.env.BASE_PATH,
      DATA_DIR: process.env.DATA_DIR,
      SESSION_SECRET: process.env.SESSION_SECRET,
      DEFAULT_TZ: process.env.DEFAULT_TZ,
      MAIL_DRIVER: process.env.MAIL_DRIVER,
      MAIL_FROM: process.env.MAIL_FROM,
      MAIL_REPLY_TO: process.env.MAIL_REPLY_TO,
      POSTMARK_TOKEN: process.env.POSTMARK_TOKEN ?? '',
      SES_REGION: process.env.SES_REGION ?? '',
      SES_ACCESS_KEY_ID: process.env.SES_ACCESS_KEY_ID ?? '',
      SES_SECRET_ACCESS_KEY: process.env.SES_SECRET_ACCESS_KEY ?? '',
      TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
      TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
      BRAND_SRC: process.env.BRAND_SRC,
      BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
      TRUST_PROXY: process.env.TRUST_PROXY,
      BIND_HOST: process.env.BIND_HOST
    }))`;
    const result = spawnSync(process.execPath, ['--env-file=.env.example', '-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
    const config = loadConfig(parsed);
    expect(config.basePath).toBe('');
    expect(config.mail.driver).toBe('console');
    expect(config.trustProxy).toEqual({ mode: 'disabled' });
    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.turnstile.siteKey).toBe('1x00000000000000000000AA');
    expect(config.brandSrc).toBe('../Hope Food Pantry Website/brand');
    expect(config.bootstrapAdminEmail).toBe('coordinator@example.invalid');
    let message = '';
    try {
      loadConfig({ ...parsed, NODE_ENV: 'production' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/console/);
    expect(message).toMatch(/test key/i);
    expect(message).toMatch(/SESSION_SECRET/);
    expect(message).toMatch(/https/);
  });
});

describe('isTurnstileTestKey', () => {
  it('recognizes the documented dummy keys and not a production-shaped key', () => {
    expect(isTurnstileTestKey('1x00000000000000000000AA')).toBe(true);
    expect(isTurnstileTestKey('2x0000000000000000000000000000000AA')).toBe(true);
    expect(isTurnstileTestKey('3x0000000000000000000000000000000AA')).toBe(true);
    expect(isTurnstileTestKey('0x4AAAAAAA8k2mRealishSiteKey00')).toBe(false);
  });
});
