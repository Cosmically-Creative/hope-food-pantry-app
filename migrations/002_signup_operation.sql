-- A repeated submit of the same form reuses this key instead of taking another spot.
ALTER TABLE signups ADD COLUMN operation_key TEXT NULL;

CREATE UNIQUE INDEX signups_operation_key
  ON signups (operation_key)
  WHERE operation_key IS NOT NULL;
