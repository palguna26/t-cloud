BEGIN;

CREATE TABLE stripe_customers (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  stripe_subscription_id text UNIQUE,
  subscription_state text NOT NULL DEFAULT 'trial',
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
