BEGIN;

CREATE TABLE context_resolution_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_text text NOT NULL,
  state text NOT NULL CHECK (state IN ('clarification_required', 'not_found')),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (workspace_id, agent_identity_id, idempotency_key)
);

CREATE INDEX context_resolution_attempts_pending
  ON context_resolution_attempts (workspace_id, state, created_at DESC)
  WHERE resolved_at IS NULL;

COMMIT;
