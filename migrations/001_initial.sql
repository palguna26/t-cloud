BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  subscription_state text NOT NULL DEFAULT 'trial',
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deletion_requested_at timestamptz
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
  kind text NOT NULL CHECK (kind IN ('claude-code', 'codex', 'opencode', 'custom')),
  created_by_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
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
CREATE INDEX agent_credentials_lookup
  ON agent_credentials (token_prefix, revoked_at, expires_at);

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
  platform text NOT NULL CHECK (platform IN ('claude-code', 'codex', 'opencode', 'custom')),
  requested_scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'claimed', 'denied')),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid REFERENCES agent_identities(id) ON DELETE CASCADE,
  authorized_by_user_id uuid,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_flow_requests_expiry
  ON device_flow_requests (status, expires_at);

CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES agent_credentials(id) ON DELETE SET NULL,
  device_authorization_id uuid REFERENCES device_authorizations(id) ON DELETE SET NULL,
  source_session_id text NOT NULL,
  source_platform text NOT NULL,
  repository_key text,
  branch text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  last_event_at timestamptz NOT NULL,
  UNIQUE (workspace_id, agent_identity_id, source_session_id)
);

CREATE TABLE work_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'proposed', 'active', 'blocked', 'in_review',
    'completed', 'cancelled', 'archived'
  )),
  current_summary text,
  repository_key text,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_agent_identity_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX work_threads_recent
  ON work_threads (workspace_id, status, updated_at DESC);
CREATE INDEX work_threads_title_trgm
  ON work_threads USING gin (title gin_trgm_ops);
CREATE INDEX work_threads_search
  ON work_threads USING gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(objective, '') || ' ' || coalesce(current_summary, ''))
  );

CREATE TABLE work_thread_agent_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  can_read_context boolean NOT NULL DEFAULT true,
  can_append_events boolean NOT NULL DEFAULT true,
  can_create_handoff boolean NOT NULL DEFAULT true,
  source text NOT NULL CHECK (source IN ('creator', 'handoff', 'human', 'contribution')),
  granted_by_user_id uuid,
  granted_by_handoff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX work_thread_agent_grants_active
  ON work_thread_agent_grants (work_thread_id, agent_identity_id)
  WHERE revoked_at IS NULL;
CREATE INDEX work_thread_agent_grants_lookup
  ON work_thread_agent_grants (workspace_id, agent_identity_id, revoked_at, work_thread_id);

CREATE TABLE source_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid REFERENCES work_threads(id) ON DELETE SET NULL,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL,
  payload_json jsonb NOT NULL,
  payload_text text,
  redaction_state text NOT NULL DEFAULT 'edge',
  content_hash text,
  UNIQUE (workspace_id, source, external_id)
);
CREATE INDEX source_events_recent
  ON source_events (workspace_id, occurred_at DESC);
CREATE INDEX source_events_work
  ON source_events (workspace_id, work_thread_id, occurred_at);

CREATE TABLE context_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'objective', 'current_state', 'decision', 'constraint', 'observation',
    'attempt', 'failure', 'blocker', 'evidence', 'expected_result',
    'next_action', 'outcome'
  )),
  text text NOT NULL,
  authority smallint NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  state text NOT NULL CHECK (state IN ('active', 'superseded', 'contradicted', 'corrected', 'deleted')),
  valid_from timestamptz,
  valid_until timestamptz,
  created_by_user_id uuid,
  created_by_agent_identity_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_items_work
  ON context_items (workspace_id, work_thread_id, state, type);
CREATE INDEX context_items_search
  ON context_items USING gin (to_tsvector('english', text));

CREATE TABLE context_item_sources (
  context_item_id uuid NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  source_event_id uuid NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
  relationship text NOT NULL,
  quote_start integer,
  quote_end integer,
  PRIMARY KEY (context_item_id, source_event_id),
  UNIQUE (source_event_id, relationship)
);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  from_agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  to_agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready', 'claimed', 'completed', 'cancelled', 'expired')),
  instruction text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by_session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  completed_at timestamptz,
  expires_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX handoffs_ready
  ON handoffs (workspace_id, to_agent_identity_id, status, created_at DESC);

ALTER TABLE work_thread_agent_grants
  ADD CONSTRAINT work_thread_agent_grants_handoff_fk
  FOREIGN KEY (granted_by_handoff_id) REFERENCES handoffs(id) ON DELETE SET NULL;

CREATE TABLE context_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_text text NOT NULL,
  resolution_state text NOT NULL,
  resolution_evidence_json jsonb NOT NULL DEFAULT '{}',
  briefing_text text NOT NULL,
  briefing_token_count integer NOT NULL CHECK (briefing_token_count >= 0),
  work_thread_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  UNIQUE (workspace_id, agent_identity_id, idempotency_key)
);

CREATE TABLE context_receipt_items (
  receipt_id uuid NOT NULL REFERENCES context_receipts(id) ON DELETE CASCADE,
  context_item_id uuid NOT NULL,
  position integer NOT NULL,
  inclusion_reason text NOT NULL,
  source_snapshot_json jsonb NOT NULL,
  PRIMARY KEY (receipt_id, context_item_id)
);

CREATE TABLE outcomes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  receipt_id uuid REFERENCES context_receipts(id) ON DELETE SET NULL,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status text NOT NULL,
  summary text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]',
  idempotency_key text NOT NULL,
  reported_at timestamptz NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE corrections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  context_item_id uuid REFERENCES context_items(id) ON DELETE SET NULL,
  action text NOT NULL,
  previous_value_json jsonb,
  new_value_json jsonb,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  leased_by text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, dedupe_key)
);
CREATE INDEX jobs_ready ON jobs (state, next_run_at);
CREATE INDEX jobs_leased ON jobs (state, lease_until);

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
CREATE INDEX audit_events_recent
  ON audit_events (workspace_id, occurred_at DESC);

COMMIT;
