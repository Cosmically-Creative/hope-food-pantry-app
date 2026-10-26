import { describe, expect, it } from 'vitest';
import { isWithinSignupWindow, signupDeadline, signupDeadlineLabel } from '../src/signup-window.js';

describe('signup window', () => {
  it('opens signup through the same local date three months ahead', () => {
    expect(signupDeadline('2026-10-14')).toBe('2027-01-14');
    expect(signupDeadlineLabel('2026-10-14')).toBe('January 14, 2027');
    expect(isWithinSignupWindow('2027-01-14', '2026-10-14')).toBe(true);
    expect(isWithinSignupWindow('2027-01-15', '2026-10-14')).toBe(false);
  });

  it('uses the last valid day when the later month is shorter', () => {
    expect(signupDeadline('2026-01-31')).toBe('2026-04-30');
    expect(isWithinSignupWindow('2026-04-30', '2026-01-31')).toBe(true);
    expect(isWithinSignupWindow('2026-05-01', '2026-01-31')).toBe(false);
  });
});
