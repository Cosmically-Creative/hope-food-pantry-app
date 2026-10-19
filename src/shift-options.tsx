import type { MoveTarget } from './admin/store.js';

export type ShiftDateGroup = {
  date: string;
  dateLabel: string;
  targets: MoveTarget[];
};

/** Groups a date-sorted shift list. The same date later in the list stays its own group so menu order matches the list. */
export function groupShiftTargets(targets: readonly MoveTarget[]): ShiftDateGroup[] {
  const groups: ShiftDateGroup[] = [];
  for (const target of targets) {
    const current = groups.at(-1);
    if (current?.date === target.date) current.targets.push(target);
    else groups.push({ date: target.date, dateLabel: target.dateLabel, targets: [target] });
  }
  return groups;
}

export function ShiftTargetOptions(props: { targets: MoveTarget[]; selectedId?: string }) {
  const selected = props.selectedId ?? '';
  return (
    <>
      <option value="" selected={selected === '' ? true : undefined}>
        Choose a shift
      </option>
      {groupShiftTargets(props.targets).map((group, index) => (
        <optgroup label={group.dateLabel} key={`${group.date}-${index}`}>
          {group.targets.map((target) => (
            <option value={String(target.id)} key={target.id} selected={selected === String(target.id) ? true : undefined}>
              {target.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
