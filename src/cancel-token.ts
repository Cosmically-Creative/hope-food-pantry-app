import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ties a cancel POST to the manage page we rendered for this link.
 * Knowing the address is not enough. The field is not a second manage token.
 */
export function issueCancelToken(secret: string, manageToken: string): string {
  return createHmac('sha256', secret).update(`hope-cancel-v1\0${manageToken}`).digest('base64url');
}

export function issueSwitchToken(secret: string, manageToken: string): string {
  return createHmac('sha256', secret).update(`hope-switch-v1\0${manageToken}`).digest('base64url');
}

export function issueReminderPageToken(secret: string, manageToken: string): string {
  return createHmac('sha256', secret).update(`hope-reminder-page-v1\0${manageToken}`).digest('base64url');
}

export function cancelTokenMatches(secret: string, manageToken: string, received: string): boolean {
  return tokenMatches(issueCancelToken(secret, manageToken), received);
}

export function switchTokenMatches(secret: string, manageToken: string, received: string): boolean {
  return tokenMatches(issueSwitchToken(secret, manageToken), received);
}

export function reminderPageTokenMatches(secret: string, manageToken: string, received: string): boolean {
  return tokenMatches(issueReminderPageToken(secret, manageToken), received);
}

function tokenMatches(expected: string, received: string): boolean {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(received)) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
