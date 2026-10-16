export type MailIdentity = {
  baseUrl: string;
  basePath: string;
  from: string;
  replyTo: string;
};

export type OutboundMail = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

/** sent: the provider accepted the message. That is not proof the person received it. */
export type MailDelivery =
  | { result: 'sent'; providerId: string | null }
  | { result: 'retry'; error: string }
  | { result: 'failed'; error: string }
  | { result: 'unknown'; error: string };

export type Mailer = {
  send(message: OutboundMail): Promise<MailDelivery>;
};
