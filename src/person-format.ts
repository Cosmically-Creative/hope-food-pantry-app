/** Capitalizes a word that is all lower or all upper. A mixed-case word stays as written. */
export function capitalizeName(value: string): string {
  const cleaned = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return cleaned.replace(/\p{L}+/gu, (letters) => {
    const lower = letters.toLocaleLowerCase('en-US');
    const upper = letters.toLocaleUpperCase('en-US');
    if (letters !== lower && letters !== upper) return letters;
    const chars = [...lower];
    const first = chars[0] ?? '';
    return first.toLocaleUpperCase('en-US') + chars.slice(1).join('');
  });
}

/**
 * Writes a 10-digit number as 000-000-0000.
 * A leading 1 is the country code and is dropped. Any other number stays as written.
 */
export function formatPhone(value: string): string {
  const trimmed = value.normalize('NFC').trim();
  const digits = trimmed.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return trimmed;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}
