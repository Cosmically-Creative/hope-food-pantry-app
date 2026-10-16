import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../src/email.js';

describe('normalizeEmail', () => {
  it('trims and lowercases without removing dots', () => {
    expect(normalizeEmail('  Ada@Example.com ')).toBe('ada@example.com');
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
  });

  it('rejects a blank address', () => {
    expect(() => normalizeEmail('   ')).toThrow(/email/i);
  });
});
