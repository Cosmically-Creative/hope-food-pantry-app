import type { AppConfig } from '../config.js';
import { createConsoleMailer } from './console.js';
import { createPostmarkMailer } from './postmark.js';
import { createSesMailer } from './ses.js';
import type { Mailer } from './types.js';

export function createMailer(config: AppConfig): Mailer {
  if (config.mail.driver === 'console') return createConsoleMailer();
  if (config.mail.driver === 'postmark') {
    if (!config.mail.postmarkToken) throw new Error('POSTMARK_TOKEN is required for the postmark mail driver.');
    return createPostmarkMailer(config.mail.postmarkToken);
  }
  if (!config.mail.ses) throw new Error('SES credentials are required for the ses mail driver.');
  return createSesMailer({
    region: config.mail.ses.region,
    accessKeyId: config.mail.ses.accessKeyId,
    secretAccessKey: config.mail.ses.secretAccessKey,
  });
}
