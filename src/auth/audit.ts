import type Database from 'better-sqlite3';

/** Records an admin or host action. Detail is ids and counts only, never addresses or notes. */
export function writeAudit(
  db: Database.Database,
  coordinatorId: number | null,
  action: string,
  detail: Record<string, number>,
  now: string,
): void {
  const json = JSON.stringify(detail);
  if (json.includes('@')) throw new Error('Audit detail cannot include an email address.');
  db.prepare('INSERT INTO audit (coordinator_id, action, detail_json, at) VALUES (?, ?, ?, ?)').run(
    coordinatorId,
    action,
    json,
    now,
  );
}
