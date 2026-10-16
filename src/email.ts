export class EmailAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailAddressError';
  }
}

/** Trim, Unicode normalize, and lowercase. Dots and plus-tags are kept. */
export function normalizeEmail(input: string): string {
  const normalized = input.normalize('NFC').trim().toLowerCase();
  if (
    normalized.length === 0 ||
    /\s/.test(normalized) ||
    !normalized.includes('@') ||
    normalized.startsWith('@') ||
    normalized.endsWith('@')
  ) {
    throw new EmailAddressError('Enter an email address.');
  }
  return normalized;
}
