import type { AppConfig } from '../config.js';
import { createConsoleMailer } from './console.js';
import { createPostmarkMailer } from './postmark.js';
import { createSesMailer } from './ses.js';
import { createSmtp2GoMailer } from './smtp2go.js';
import type { Mailer } from './types.js';

export function createMailer(config: AppConfig): Mailer {
  if (config.mail.driver === 'console') return createConsoleMailer();
  if (config.mail.driver === 'smtp2go') {
    if (!config.mail.smtp2goApiKey) throw new Error('SMTP2GO_API_KEY is required for the smtp2go mail driver.');
    return createSmtp2GoMailer(config.mail.smtp2goApiKey);
  }
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
