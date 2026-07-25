BEGIN;

CREATE TABLE rate_limit_buckets (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0)
);

COMMIT;
