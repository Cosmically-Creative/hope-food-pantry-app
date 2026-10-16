-- One successful daily job per scope and local date. A repeated clock hour does not run it again.
CREATE TABLE job_runs (
  job TEXT NOT NULL,
  scope TEXT NOT NULL,
  local_date TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ran_at TEXT NOT NULL CHECK (
    ran_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  PRIMARY KEY (job, scope, local_date)
);
