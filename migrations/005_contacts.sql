-- Coordinator contact list. A row is not a signup and does not take a spot.
-- The signup retention job does not clear this table.
-- Deletes do not cascade. Removing a contact leaves signups in place.

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL CHECK (
    length(trim(first_name)) > 0
    AND length(first_name) <= 80
    AND instr(first_name, char(10)) = 0
    AND instr(first_name, char(13)) = 0
  ),
  last_name TEXT NOT NULL CHECK (
    length(trim(last_name)) > 0
    AND length(last_name) <= 80
    AND instr(last_name, char(10)) = 0
    AND instr(last_name, char(13)) = 0
  ),
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE CHECK (
    email_norm = lower(email_norm)
    AND instr(email_norm, ' ') = 0
    AND instr(email_norm, '@') > 1
    AND instr(email_norm, char(10)) = 0
    AND instr(email_norm, char(13)) = 0
  ),
  phone TEXT NULL CHECK (
    phone IS NULL
    OR (
      length(phone) BETWEEN 1 AND 40
      AND instr(phone, char(10)) = 0
      AND instr(phone, char(13)) = 0
    )
  ),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  CHECK (length(first_name) + length(last_name) + 1 <= 80)
);
