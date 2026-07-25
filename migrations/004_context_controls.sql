BEGIN;

CREATE TABLE context_item_agent_restrictions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_item_id uuid NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_item_id, agent_identity_id)
);
CREATE INDEX context_item_agent_restrictions_lookup
  ON context_item_agent_restrictions (workspace_id, agent_identity_id, context_item_id);

CREATE TABLE work_thread_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  target_work_thread_id uuid NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('merged_into', 'split_from')),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_work_thread_id <> target_work_thread_id)
);
CREATE INDEX work_thread_links_source
  ON work_thread_links (workspace_id, source_work_thread_id);
CREATE INDEX work_thread_links_target
  ON work_thread_links (workspace_id, target_work_thread_id);

COMMIT;
