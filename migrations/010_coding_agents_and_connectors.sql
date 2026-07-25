BEGIN;

-- Preserve legacy history, but make unsupported identities inert.
UPDATE agent_identities SET status = 'disabled' WHERE kind = 'custom';
UPDATE agent_credentials
SET revoked_at = COALESCE(revoked_at, now())
WHERE agent_identity_id IN (SELECT id FROM agent_identities WHERE kind = 'custom');
UPDATE device_authorizations
SET revoked_at = COALESCE(revoked_at, now())
WHERE agent_identity_id IN (SELECT id FROM agent_identities WHERE kind = 'custom');
UPDATE device_flow_requests SET status = 'denied' WHERE platform = 'custom';

ALTER TABLE agent_identities DROP CONSTRAINT agent_identities_kind_check;
ALTER TABLE agent_identities ADD CONSTRAINT agent_identities_kind_check
  CHECK (
    kind IN ('claude-code', 'codex', 'opencode')
    OR (kind = 'custom' AND status = 'disabled')
  );

ALTER TABLE device_flow_requests DROP CONSTRAINT device_flow_requests_platform_check;
ALTER TABLE device_flow_requests ADD CONSTRAINT device_flow_requests_platform_check
  CHECK (
    platform IN ('claude-code', 'codex', 'opencode')
    OR (platform = 'custom' AND status = 'denied')
  );

CREATE TABLE connector_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'slack', 'linear')),
  name text NOT NULL,
  external_account_id text NOT NULL,
  credentials_ciphertext bytea,
  selected_scopes jsonb NOT NULL DEFAULT '[]',
  sync_cursor text,
  last_synced_at timestamptz,
  last_error text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'error', 'revoked')),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, provider, external_account_id),
  UNIQUE (provider, external_account_id),
  UNIQUE (workspace_id, id)
);
CREATE INDEX connector_connections_workspace
  ON connector_connections (workspace_id, provider, status);

CREATE TABLE connector_oauth_states (
  state_hash bytea PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'slack', 'linear')),
  user_id uuid NOT NULL,
  selected_scopes jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_oauth_states_expiry
  ON connector_oauth_states (expires_at) WHERE used_at IS NULL;

CREATE TABLE connector_scope_mappings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_connection_id uuid NOT NULL
    REFERENCES connector_connections(id) ON DELETE CASCADE,
  external_scope_id text NOT NULL,
  external_scope_name text NOT NULL,
  repository_key text NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_connection_id, external_scope_id)
);
CREATE INDEX connector_scope_mappings_repository
  ON connector_scope_mappings (workspace_id, repository_key);

ALTER TABLE source_events
  ALTER COLUMN agent_identity_id DROP NOT NULL,
  ALTER COLUMN agent_session_id DROP NOT NULL,
  ADD COLUMN connector_connection_id uuid
    REFERENCES connector_connections(id) ON DELETE SET NULL,
  ADD COLUMN canonical_url text,
  ADD COLUMN provider_updated_at timestamptz;

ALTER TABLE source_events ADD CONSTRAINT source_events_exactly_one_origin
  CHECK (
    (
      agent_identity_id IS NOT NULL
      AND agent_session_id IS NOT NULL
      AND connector_connection_id IS NULL
    )
    OR
    (
      agent_identity_id IS NULL
      AND agent_session_id IS NULL
      AND connector_connection_id IS NOT NULL
    )
  );
CREATE INDEX source_events_connector
  ON source_events (workspace_id, connector_connection_id, occurred_at DESC);

CREATE TABLE source_event_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_event_id uuid NOT NULL REFERENCES source_events(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  reason text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  state text NOT NULL CHECK (state IN ('automatic', 'proposed', 'confirmed', 'rejected')),
  cross_repository boolean NOT NULL DEFAULT false,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  created_by_user_id uuid,
  confirmed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  UNIQUE (source_event_id, work_thread_id)
);
CREATE INDEX source_event_links_attention
  ON source_event_links (workspace_id, state, created_at DESC)
  WHERE state = 'proposed';

COMMIT;
