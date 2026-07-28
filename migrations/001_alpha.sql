BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE agent_identities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('claude-code', 'codex')),
  created_by_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  token_prefix text NOT NULL UNIQUE,
  secret_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  created_by_user_id uuid NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  authorized_by_user_id uuid NOT NULL,
  device_name text NOT NULL,
  token_prefix text NOT NULL UNIQUE,
  secret_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE device_flow_requests (
  id uuid PRIMARY KEY,
  device_code_hash bytea NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  device_name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('claude-code', 'codex')),
  requested_scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'claimed', 'denied')),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid REFERENCES agent_identities(id) ON DELETE CASCADE,
  authorized_by_user_id uuid,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'slack')),
  name text NOT NULL,
  external_account_id text NOT NULL,
  credentials_ciphertext bytea,
  selected_scopes jsonb NOT NULL DEFAULT '[]',
  last_synced_at timestamptz,
  last_error text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, provider, external_account_id)
);
CREATE TABLE connector_oauth_states (
  state_hash bytea PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'slack')),
  user_id uuid NOT NULL,
  selected_scopes jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connector_scope_mappings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_connection_id uuid NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  external_scope_id text NOT NULL,
  external_scope_name text NOT NULL,
  repository_key text NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_connection_id, external_scope_id)
);

CREATE TABLE alpha_source_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('agent', 'slack', 'github')),
  external_id text NOT NULL,
  record_type text NOT NULL,
  parent_record_id uuid,
  repository text,
  branch text,
  issue_or_pr_reference text,
  commit_sha text,
  content text NOT NULL,
  author text,
  source_url text,
  event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_id)
);
CREATE INDEX alpha_source_records_lookup ON alpha_source_records (workspace_id, repository, branch, event_at DESC);
CREATE TABLE alpha_agent_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_session_id text NOT NULL,
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex')),
  repository text NOT NULL,
  branch text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  completion_status text,
  summary_json jsonb,
  UNIQUE (workspace_id, external_session_id)
);
CREATE TABLE alpha_memories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_type text NOT NULL CHECK (memory_type IN ('decision', 'requirement', 'problem', 'failed_attempt', 'progress', 'outcome', 'unfinished_work')),
  content text NOT NULL,
  repository text,
  branch text,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL,
  event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alpha_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  packet_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  delivery_status text CHECK (delivery_status IN ('delivered', 'failed')),
  acknowledged_at timestamptz,
  idempotency_key text,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE TABLE alpha_memory_sources (
  memory_id uuid NOT NULL REFERENCES alpha_memories(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES alpha_source_records(id) ON DELETE CASCADE,
  agent_session_id uuid REFERENCES alpha_agent_sessions(id) ON DELETE SET NULL,
  PRIMARY KEY (memory_id, source_record_id)
);
CREATE TABLE alpha_sync_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  payload_json jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
