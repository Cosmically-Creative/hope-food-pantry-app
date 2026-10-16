import type { Mailer, OutboundMail } from './types.js';

/** Development mailbox. The message is accepted locally and printed. It is not delivered to a person. */
export function createConsoleMailer(write: (line: string) => void = (line) => console.log(line)): Mailer {
  return {
    async send(message: OutboundMail) {
      const extra = Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
      write([
        'Mail console driver accepted a message.',
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        ...extra,
        message.text,
      ].join('\n'));
      return { result: 'sent', providerId: null };
    },
  };
}
