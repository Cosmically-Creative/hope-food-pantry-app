import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { redactMailError } from './redact.js';
import type { MailDelivery, Mailer, OutboundMail } from './types.js';

const PERMANENT = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
]);

const RETRYABLE = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'ServiceUnavailableException',
  'InternalFailure',
]);

export type SesSender = {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<{ MessageId?: string }>;
};

/** SESv2 SendEmail. Acceptance is MessageId, not proof the person received the mail. */
export function createSesMailer(options: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  client?: SesSender;
}): Mailer {
  const client = options.client ?? new SESv2Client({
    maxAttempts: 1,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
  return {
    async send(message: OutboundMail): Promise<MailDelivery> {
      try {
        const result = await client.send(new SendEmailCommand({
          FromEmailAddress: message.from,
          Destination: { ToAddresses: [message.to] },
          ReplyToAddresses: [message.replyTo],
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.text, Charset: 'UTF-8' },
                Html: { Data: message.html, Charset: 'UTF-8' },
              },
              ...(message.headers && Object.keys(message.headers).length > 0
                ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
                : {}),
            },
          },
        }), { abortSignal: AbortSignal.timeout(15_000) });
        return { result: 'sent', providerId: result.MessageId ?? null };
      } catch (err) {
        return mapSesError(err);
      }
    },
  };
}

function mapSesError(err: unknown): MailDelivery {
  const name = err instanceof Error ? err.name : '';
  const error = redactMailError(err instanceof Error ? err.message : 'SES request failed.');
  if (PERMANENT.has(name)) return { result: 'failed', error };
  if (RETRYABLE.has(name)) return { result: 'retry', error };
  if (name === 'TimeoutError' || name === 'AbortError') return { result: 'unknown', error };
  return { result: 'unknown', error };
}
