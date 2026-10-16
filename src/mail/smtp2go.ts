import { redactMailError } from './redact.js';
import type { MailDelivery, Mailer, OutboundMail } from './types.js';

const ENDPOINT = 'https://api.smtp2go.com/v3/email/send';

type Smtp2GoPayload = {
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: unknown[];
    email_id?: string;
    error?: string;
    error_code?: string;
  };
};

/**
 * SMTP2GO's send API. A 200 response can still contain a failure, so the body is checked.
 * fastaccept stays off so a rejected sender is a failure here, not an accepted message
 * whose later result this app would never see. Acceptance is email_id, not proof of delivery.
 * The outbox dedupe key prevents a second send. SMTP2GO has no idempotency key.
 */
export function createSmtp2GoMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
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
            'X-Smtp2go-Api-Key': apiKey,
          },
          body: JSON.stringify({
            sender: message.from,
            to: [message.to],
            subject: message.subject,
            text_body: message.text,
            html_body: message.html,
            custom_headers: customHeaders(message),
          }),
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : 'SMTP2GO request failed.';
        const uncertain = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        return {
          result: uncertain ? 'unknown' : 'retry',
          error: redactMailError(messageText),
        };
      }
      if (response.status === 408 || response.status === 504) {
        return { result: 'unknown', error: `SMTP2GO responded ${response.status}.` };
      }
      if (response.status === 429 || response.status >= 500) {
        return { result: 'retry', error: `SMTP2GO responded ${response.status}.` };
      }
      let payload: Smtp2GoPayload = {};
      try {
        payload = (await response.json()) as Smtp2GoPayload;
      } catch {
        return { result: response.ok ? 'unknown' : 'failed', error: `SMTP2GO responded ${response.status}.` };
      }
      const data = payload.data ?? {};
      if (!response.ok || data.error) {
        return { result: 'failed', error: redactMailError(data.error || `SMTP2GO responded ${response.status}.`) };
      }
      const failed = data.failed ?? 0;
      if (failed > 0 || (data.succeeded ?? 0) < 1) {
        return { result: 'failed', error: redactMailError(failureText(data.failures)) };
      }
      if (!data.email_id) {
        return { result: 'unknown', error: 'SMTP2GO accepted the request without an email id.' };
      }
      return { result: 'sent', providerId: data.email_id };
    },
  };
}

function customHeaders(message: OutboundMail): { header: string; value: string }[] {
  const headers = [{ header: 'Reply-To', value: message.replyTo }];
  for (const [header, value] of Object.entries(message.headers ?? {})) {
    if (header.toLowerCase() === 'reply-to') continue;
    headers.push({ header, value });
  }
  return headers;
}

function failureText(failures: unknown[] | undefined): string {
  const parts = (failures ?? []).map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const record = item as { error?: unknown; message?: unknown };
      if (typeof record.error === 'string') return record.error;
      if (typeof record.message === 'string') return record.message;
    }
    return '';
  }).filter((part) => part !== '');
  return parts.join(' ') || 'SMTP2GO rejected the message.';
}
