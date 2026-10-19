import { describe, expect, it } from 'vitest';
import { groupShiftTargets } from '../src/shift-options.js';
import type { MoveTarget } from '../src/admin/store.js';

function target(id: number, date: string, dateLabel: string): MoveTarget {
  return { id, date, dateLabel, label: `Shift ${id}` };
}

describe('shift menu groups', () => {
  it('keeps same-day shifts together and leaves a later repeat of that date in place', () => {
    const groups = groupShiftTargets([
      target(1, '2026-10-20', 'Tuesday, October 20, 2026'),
      target(2, '2026-10-20', 'Tuesday, October 20, 2026'),
      target(3, '2026-10-21', 'Wednesday, October 21, 2026'),
      target(4, '2026-10-20', 'Tuesday, October 20, 2026'),
    ]);
    expect(groups.map((group) => group.targets.map((item) => item.id))).toEqual([[1, 2], [3], [4]]);
    expect(groups.map((group) => group.dateLabel)).toEqual([
      'Tuesday, October 20, 2026',
      'Wednesday, October 21, 2026',
      'Tuesday, October 20, 2026',
    ]);
  });
});
