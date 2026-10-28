-- foreign-keys: off
-- Rebuilding signups drops the table. outbox and reminders_sent reference it, so foreign keys are off for this file.
-- group_size is how many spots this one signup holds. Names for the extra people are not stored.

CREATE TABLE signups_next (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts (id) ON DELETE NO ACTION,
  name TEXT NULL,
  email TEXT NULL,
  email_norm TEXT NULL,
  phone TEXT NULL,
  is_minor INTEGER NOT NULL DEFAULT 0 CHECK (is_minor IN (0, 1)),
  guardian_name TEXT NULL,
  guardian_email TEXT NULL,
  group_size INTEGER NOT NULL DEFAULT 1 CHECK (group_size >= 1 AND group_size <= 20),
  notes TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  manage_token_hash TEXT NULL UNIQUE,
  token_expires_at TEXT NULL CHECK (
    token_expires_at IS NULL
    OR token_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  reminders_off INTEGER NOT NULL DEFAULT 0 CHECK (reminders_off IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  anonymized_at TEXT NULL CHECK (
    anonymized_at IS NULL
    OR anonymized_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  operation_key TEXT NULL,
  CHECK (
    (
      anonymized_at IS NULL
      AND name IS NOT NULL
      AND length(trim(name)) > 0
      AND email IS NOT NULL
      AND email_norm IS NOT NULL
    )
    OR (
      anonymized_at IS NOT NULL
      AND name IS NULL
      AND email IS NULL
      AND email_norm IS NULL
      AND phone IS NULL
      AND guardian_name IS NULL
      AND guardian_email IS NULL
      AND notes IS NULL
      AND manage_token_hash IS NULL
      AND token_expires_at IS NULL
    )
  ),
  CHECK (
    anonymized_at IS NOT NULL
    OR is_minor = 0
    OR (
      guardian_name IS NOT NULL
      AND length(trim(guardian_name)) > 0
      AND guardian_email IS NOT NULL
      AND length(trim(guardian_email)) > 0
    )
  ),
  CHECK (
    email_norm IS NULL
    OR (
      email_norm = lower(email_norm)
      AND instr(email_norm, ' ') = 0
      AND instr(email_norm, '@') > 1
      AND instr(email_norm, char(10)) = 0
      AND instr(email_norm, char(13)) = 0
    )
  )
);

INSERT INTO signups_next (
  id, shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
  group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
  created_at, updated_at, anonymized_at, operation_key
)
SELECT
  id, shift_id, name, email, email_norm, phone, is_minor, guardian_name, guardian_email,
  group_size, notes, status, manage_token_hash, token_expires_at, reminders_off,
  created_at, updated_at, anonymized_at, operation_key
FROM signups;

DROP TABLE signups;

ALTER TABLE signups_next RENAME TO signups;

CREATE INDEX signups_by_shift ON signups (shift_id, status);

CREATE INDEX signups_by_email_norm
  ON signups (email_norm)
  WHERE email_norm IS NOT NULL;

CREATE UNIQUE INDEX signups_one_confirmed_person_per_shift
  ON signups (shift_id, email_norm, name COLLATE NOCASE)
  WHERE status = 'confirmed' AND email_norm IS NOT NULL AND name IS NOT NULL;

CREATE UNIQUE INDEX signups_operation_key
  ON signups (operation_key)
  WHERE operation_key IS NOT NULL;
