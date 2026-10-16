-- A contact is one name at one email address.
-- Two different names can share an email and stay two contacts.
-- The signup retention job does not clear this table.

CREATE TABLE contacts_next (
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
  email_norm TEXT NOT NULL CHECK (
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

INSERT INTO contacts_next (id, first_name, last_name, email, email_norm, phone, created_at, updated_at)
SELECT id, first_name, last_name, email, email_norm, phone, created_at, updated_at FROM contacts;

DROP TABLE contacts;
ALTER TABLE contacts_next RENAME TO contacts;

CREATE UNIQUE INDEX contacts_one_name_per_email
  ON contacts (first_name COLLATE NOCASE, last_name COLLATE NOCASE, email_norm);

UPDATE contacts
SET phone = substr(phone, 1, 3) || '-' || substr(phone, 4, 3) || '-' || substr(phone, 7, 4)
WHERE phone GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';

UPDATE contacts
SET phone = substr(phone, 2, 3) || '-' || substr(phone, 5, 3) || '-' || substr(phone, 8, 4)
WHERE phone GLOB '1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';
