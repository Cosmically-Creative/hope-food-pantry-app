export function devEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    BASE_URL: 'http://127.0.0.1:3000',
    BASE_PATH: '',
    DATA_DIR: './data',
    SESSION_SECRET: 'dev-only-change-me-not-for-production-use',
    DEFAULT_TZ: 'America/Chicago',
    MAIL_DRIVER: 'console',
    MAIL_FROM: 'Hope Food Pantry <volunteer@example.invalid>',
    MAIL_REPLY_TO: 'volunteer@example.invalid',
    SMTP2GO_API_KEY: '',
    POSTMARK_TOKEN: '',
    SES_REGION: '',
    SES_ACCESS_KEY_ID: '',
    SES_SECRET_ACCESS_KEY: '',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    BRAND_SRC: '../Hope Food Pantry Website/brand',
    BOOTSTRAP_ADMIN_EMAIL: 'coordinator@example.invalid',
    TRUST_PROXY: 'false',
    ...overrides,
  };
}

export function productionEnv(dataDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return devEnv({
    NODE_ENV: 'production',
    BASE_URL: 'https://volunteer.example.org',
    DATA_DIR: dataDir,
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    MAIL_DRIVER: 'smtp2go',
    MAIL_FROM: 'Hope Food Pantry <volunteer@example.org>',
    MAIL_REPLY_TO: 'volunteer@example.org',
    SMTP2GO_API_KEY: 'api-9f3a2c1e5b8d4f70a1b2c3d4e5f6',
    POSTMARK_TOKEN: 'pm-server-token-9f3a2c1e5b8d4f70',
    TURNSTILE_SITE_KEY: '0x4AAAAAAA8k2mRealishSiteKey00',
    TURNSTILE_SECRET_KEY: '0x4AAAAAAA8k2mRealishSecretKey00',
    BOOTSTRAP_ADMIN_EMAIL: 'coordinator@example.org',
    TRUST_PROXY: 'false',
    ...overrides,
  });
}
