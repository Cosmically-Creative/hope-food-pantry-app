-- Hope Volunteer core schema.
-- Instants are UTC text: YYYY-MM-DDTHH:MM:SS.SSSZ
-- Local dates are YYYY-MM-DD. Local times are HH:MM. Weekday 0 is Sunday.
-- Foreign keys and WAL are enabled on each connection, not in this file.
-- Applied files are checksummed. Add a new migration instead of editing this one
-- after it has been applied to a database you need to keep.
-- Deletes do not cascade. Cancelling a shift keeps the roster.

CREATE TABLE coordinators (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (
    instr(email, '@') > 1
    AND email = lower(email)
    AND instr(email, ' ') = 0
  ),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role TEXT NOT NULL CHECK (role IN ('admin', 'coordinator')),
  -- Password login is deferred. Leave this NULL.
  password_hash TEXT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  coordinator_id INTEGER NOT NULL REFERENCES coordinators (id) ON DELETE NO ACTION,
  csrf TEXT NOT NULL CHECK (length(csrf) > 0),
  expires_at TEXT NOT NULL CHECK (
    expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  last_seen_at TEXT NOT NULL CHECK (
    last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  coordinator_id INTEGER NOT NULL REFERENCES coordinators (id) ON DELETE NO ACTION,
  expires_at TEXT NOT NULL CHECK (
    expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  used_at TEXT NULL CHECK (
    used_at IS NULL
    OR used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 1 AND 80
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT GLOB '-*'
    AND slug NOT GLOB '*-'
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL CHECK (length(trim(tz)) > 0),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE TABLE shift_templates (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE NO ACTION,
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local TEXT NOT NULL CHECK (
    start_local GLOB '[0-9][0-9]:[0-5][0-9]'
    AND start_local < '24:00'
  ),
  end_local TEXT NOT NULL CHECK (
    end_local GLOB '[0-9][0-9]:[0-5][0-9]'
    AND end_local < '24:00'
  ),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  starts_on TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on TEXT NULL CHECK (
    ends_on IS NULL
    OR ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (end_local > start_local)
);

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE NO ACTION,
  template_id INTEGER NULL REFERENCES shift_templates (id) ON DELETE NO ACTION,
  occurrence_date TEXT NULL CHECK (
    occurrence_date IS NULL
    OR occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  template_revision INTEGER NULL CHECK (template_revision IS NULL OR template_revision > 0),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  starts_at_utc TEXT NOT NULL CHECK (
    starts_at_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  ends_at_utc TEXT NOT NULL CHECK (
    ends_at_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  notes TEXT NOT NULL DEFAULT '',
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  manually_modified INTEGER NOT NULL DEFAULT 0 CHECK (manually_modified IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (ends_at_utc > starts_at_utc),
  -- A generated occurrence keeps its date even when cancelled, so regeneration cannot recreate it.
  CHECK (
    (
      template_id IS NULL
      AND occurrence_date IS NULL
      AND template_revision IS NULL
    )
    OR (
      template_id IS NOT NULL
      AND occurrence_date IS NOT NULL
      AND template_revision IS NOT NULL
    )
  )
);

-- Includes cancelled occurrences. One-off shifts stay outside this index.
CREATE UNIQUE INDEX shifts_one_row_per_occurrence
  ON shifts (template_id, occurrence_date)
  WHERE template_id IS NOT NULL;

CREATE INDEX shifts_by_event_start ON shifts (event_id, starts_at_utc);

CREATE TABLE signups (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts (id) ON DELETE NO ACTION,
  name TEXT NULL,
  email TEXT NULL,
  email_norm TEXT NULL,
  phone TEXT NULL,
  is_minor INTEGER NOT NULL DEFAULT 0 CHECK (is_minor IN (0, 1)),
  guardian_name TEXT NULL,
  guardian_email TEXT NULL,
  -- TODO(D2): Individual signup only. group_size stays 1 until the pantry says groups are required.
  group_size INTEGER NOT NULL DEFAULT 1 CHECK (group_size = 1),
  notes TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  manage_token_hash TEXT NULL UNIQUE,
  token_expires_at TEXT NULL CHECK (
    token_expires_at IS NULL
    OR token_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  reminders_off INTEGER NOT NULL DEFAULT 0 CHECK (reminders_off IN (0, 1)),
  attended INTEGER NULL CHECK (attended IS NULL OR attended IN (0, 1)),
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

-- NULL email_norm does not collide, so anonymized rows can share a shift.
CREATE UNIQUE INDEX signups_one_confirmed_email_per_shift
  ON signups (shift_id, email_norm)
  WHERE status = 'confirmed' AND email_norm IS NOT NULL;

CREATE INDEX signups_by_shift ON signups (shift_id, status);

CREATE INDEX signups_by_email_norm
  ON signups (email_norm)
  WHERE email_norm IS NOT NULL;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  signup_id INTEGER NULL REFERENCES signups (id) ON DELETE NO ACTION,
  shift_id INTEGER NULL REFERENCES shifts (id) ON DELETE NO ACTION,
  -- confirmation, changed, cancelled, reminder, magic_link, manage_recovery
  kind TEXT NOT NULL CHECK (
    kind IN ('confirmation', 'changed', 'cancelled', 'reminder', 'magic_link', 'manage_recovery')
  ),
  -- Pending mail can contain raw manage or login links. Treat the row as sensitive.
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers_json)),
  send_after TEXT NOT NULL CHECK (
    send_after GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'delivery_unknown')
  ),
  provider_id TEXT NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  claimed_at TEXT NULL CHECK (
    claimed_at IS NULL
    OR claimed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  lease_expires_at TEXT NULL CHECK (
    lease_expires_at IS NULL
    OR lease_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  -- sent_at means the provider accepted the message, not that the person received it.
  sent_at TEXT NULL CHECK (
    sent_at IS NULL
    OR sent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  delivery_unknown_at TEXT NULL CHECK (
    delivery_unknown_at IS NULL
    OR delivery_unknown_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE INDEX outbox_by_status_send_after ON outbox (status, send_after);

-- queued_at means the reminder was queued. sent_at means the provider accepted it.
-- kind here is the offset identity, such as 48h, together with shift_version.
CREATE TABLE reminders_sent (
  signup_id INTEGER NOT NULL REFERENCES signups (id) ON DELETE NO ACTION,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  shift_version INTEGER NOT NULL CHECK (shift_version > 0),
  outbox_id INTEGER NOT NULL REFERENCES outbox (id) ON DELETE NO ACTION,
  queued_at TEXT NOT NULL CHECK (
    queued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  sent_at TEXT NULL CHECK (
    sent_at IS NULL
    OR sent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  PRIMARY KEY (signup_id, kind, shift_version)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  coordinator_id INTEGER NULL REFERENCES coordinators (id) ON DELETE NO ACTION,
  action TEXT NOT NULL CHECK (length(action) > 0),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  at TEXT NOT NULL CHECK (
    at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE INDEX audit_by_time ON audit (at);

CREATE TABLE rate_hits (
  key TEXT NOT NULL,
  window_start TEXT NOT NULL CHECK (
    window_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
);

CREATE INDEX sessions_by_coordinator ON sessions (coordinator_id);
CREATE INDEX login_tokens_by_coordinator ON login_tokens (coordinator_id);
