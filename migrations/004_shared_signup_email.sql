-- A shared inbox can sign up more than one person on the same shift.
-- The same person, matched by name without regard to case, still takes only one spot.
DROP INDEX signups_one_confirmed_email_per_shift;

CREATE UNIQUE INDEX signups_one_confirmed_person_per_shift
  ON signups (shift_id, email_norm, name COLLATE NOCASE)
  WHERE status = 'confirmed' AND email_norm IS NOT NULL AND name IS NOT NULL;
