-- foreign-keys: off
-- Coordinator roster notices use outbox kind notice.
-- Rebuilding outbox changes its CHECK list. reminders_sent references it, so foreign keys are off for this file.

CREATE TABLE outbox_next (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  signup_id INTEGER NULL REFERENCES signups (id) ON DELETE NO ACTION,
  shift_id INTEGER NULL REFERENCES shifts (id) ON DELETE NO ACTION,
  -- confirmation, changed, cancelled, reminder, magic_link, manage_recovery, notice
  kind TEXT NOT NULL CHECK (
    kind IN ('confirmation', 'changed', 'cancelled', 'reminder', 'magic_link', 'manage_recovery', 'notice')
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

INSERT INTO outbox_next (
  id, dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
  headers_json, send_after, attempts, status, provider_id, last_error, created_at,
  claimed_at, lease_expires_at, sent_at, delivery_unknown_at
)
SELECT
  id, dedupe_key, signup_id, shift_id, kind, to_email, subject, body_text, body_html,
  headers_json, send_after, attempts, status, provider_id, last_error, created_at,
  claimed_at, lease_expires_at, sent_at, delivery_unknown_at
FROM outbox;

DROP TABLE outbox;

ALTER TABLE outbox_next RENAME TO outbox;

CREATE INDEX outbox_by_status_send_after ON outbox (status, send_after);
