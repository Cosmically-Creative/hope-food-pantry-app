import { redactMailError } from './redact.js';
import type { MailDelivery, Mailer, OutboundMail } from './types.js';

const ENDPOINT = 'https://api.postmarkapp.com/email';

/**
 * Postmark's send API. There is no idempotency key that makes a second POST harmless,
 * so a duplicate is prevented by the outbox dedupe key, not by Postmark.
 */
export function createPostmarkMailer(token: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(message: OutboundMail): Promise<MailDelivery> {
      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': token,
          },
          body: JSON.stringify({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            TextBody: message.text,
            HtmlBody: message.html,
            ReplyTo: message.replyTo,
            MessageStream: 'outbound',
            ...(message.headers && Object.keys(message.headers).length > 0
              ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
              : {}),
          }),
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : 'Postmark request failed.';
        const uncertain = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        return {
          result: uncertain ? 'unknown' : 'retry',
          error: redactMailError(messageText),
        };
      }
      if (response.status === 408 || response.status === 504) {
        return { result: 'unknown', error: `Postmark responded ${response.status}.` };
      }
      if (response.status === 429 || response.status >= 500) {
        return { result: 'retry', error: `Postmark responded ${response.status}.` };
      }
      let payload: { ErrorCode?: number; Message?: string; MessageID?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        return { result: response.ok ? 'unknown' : 'failed', error: `Postmark responded ${response.status}.` };
      }
      if (response.ok && (payload.ErrorCode === undefined || payload.ErrorCode === 0)) {
        return { result: 'sent', providerId: payload.MessageID ?? null };
      }
      return { result: 'failed', error: redactMailError(payload.Message || `Postmark responded ${response.status}.`) };
    },
  };
}
