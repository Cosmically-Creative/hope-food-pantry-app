-- version_at is when this shift's version last changed.
-- A reminder due before that time, or before the signup, is not sent.
ALTER TABLE shifts ADD COLUMN version_at TEXT NULL CHECK (
  version_at IS NULL
  OR version_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
);

UPDATE shifts
SET version_at = (
  SELECT MAX(created_at)
  FROM outbox
  WHERE outbox.shift_id = shifts.id AND outbox.kind = 'changed'
)
WHERE version > 1;
