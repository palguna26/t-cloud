BEGIN;

CREATE TABLE workspace_invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash bytea NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by_user_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_invites_workspace
  ON workspace_invites (workspace_id, created_at DESC);

COMMIT;
