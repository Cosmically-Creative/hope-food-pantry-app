/** Drop addresses and manage links before an error is stored or logged. */
export function redactMailError(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\/m\/[A-Za-z0-9_-]{10,}/g, '/m/[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
