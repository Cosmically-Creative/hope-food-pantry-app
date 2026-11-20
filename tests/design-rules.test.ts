import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillLabel, spotsSentence } from '../src/schedule.js';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'css', 'app.css'), 'utf8');

/** Smallest text in the app is 14px. Footer fine print may use 13px. */
function pixels(value: string): number | null {
  const match = /^([0-9.]+)(rem|px)$/.exec(value.trim());
  if (!match) return null;
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1]);
}

describe('design rules', () => {
  it('keeps text at 14px or larger', () => {
    const small = [...css.matchAll(/font-size:\s*([^;]+);/g)]
      .map((match) => match[1] ?? '')
      .filter((value) => {
        const px = pixels(value);
        return px !== null && px < 14;
      });
    expect(small).toEqual([]);
    expect(css).toContain('--hope-text-small: 0.875rem;');
    expect(css).toContain('--hope-text-fine: 13px;');
  });

  it('counts filled spots the same way everywhere', () => {
    expect(spotsSentence({ occupied: 4, capacity: 6 })).toBe('4 of 6 spots filled');
    expect(spotsSentence({ occupied: 9, capacity: 6 })).toBe('6 of 6 spots filled');
    expect(fillLabel({ occupied: 6, capacity: 6 })).toEqual({ tone: 'full', text: 'Full · 6 of 6' });
    expect(fillLabel({ occupied: 4, capacity: 6 })).toEqual({ tone: 'open', text: '2 open · 4 of 6' });
    expect(fillLabel({ occupied: 3, capacity: 6 })).toEqual({ tone: 'open', text: '3 open · 3 of 6' });
    expect(fillLabel({ occupied: 2, capacity: 6 })).toEqual({ tone: 'needs', text: '4 open · 2 of 6' });
  });
});
