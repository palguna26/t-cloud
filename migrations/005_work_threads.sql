BEGIN;

ALTER TABLE source_records
  ADD COLUMN connector_connection_id uuid REFERENCES connector_connections(id) ON DELETE SET NULL,
  ADD COLUMN entity_key text,
  ADD COLUMN provider_event_id text,
  ADD COLUMN content_hash text,
  ADD COLUMN provider_updated_at timestamptz,
  ADD COLUMN revoked_at timestamptz;

CREATE UNIQUE INDEX source_records_provider_event_unique
  ON source_records (workspace_id, source_type, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX source_records_entity_versions
  ON source_records (workspace_id, source_type, entity_key, provider_updated_at DESC, event_at DESC);

CREATE TABLE work_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  linear_issue_key text NOT NULL,
  title text NOT NULL,
  repository_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'completed', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  link_urls text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, linear_issue_key)
);

CREATE TABLE work_thread_evidence (
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  link_reason text NOT NULL CHECK (link_reason IN ('linear_root', 'explicit_url', 'explicit_key', 'agent_outcome', 'human')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_thread_id, source_record_id)
);

CREATE TABLE claims (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  claim_type text NOT NULL CHECK (claim_type IN ('requirement', 'constraint', 'decision', 'attempt', 'fact', 'outcome')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'conflicting', 'resolved', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_thread_id, source_record_id, claim_type)
);

ALTER TABLE alpha_receipts
  ADD COLUMN work_thread_id uuid REFERENCES work_threads(id) ON DELETE SET NULL,
  ADD COLUMN work_thread_version integer;

COMMIT;
