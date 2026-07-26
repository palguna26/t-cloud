BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS source_policy_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_policy_confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS source_policy_version integer NOT NULL DEFAULT 1;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS repository_key text,
  ADD COLUMN IF NOT EXISTS branch text,
  ADD COLUMN IF NOT EXISTS instruction_snapshot text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE context_items
  ADD COLUMN IF NOT EXISTS trust_status text NOT NULL DEFAULT 'observed'
    CHECK (trust_status IN ('observed','inferred','verified','proposed','conflicting','stale')),
  ADD COLUMN IF NOT EXISTS freshness timestamptz,
  ADD COLUMN IF NOT EXISTS extraction_model text,
  ADD COLUMN IF NOT EXISTS extraction_version text;

ALTER TABLE context_receipts
  ADD COLUMN IF NOT EXISTS abstention_code text,
  ADD COLUMN IF NOT EXISTS abstention_message text,
  ADD COLUMN IF NOT EXISTS final_packet text,
  ADD COLUMN IF NOT EXISTS final_packet_sha256 text,
  ADD COLUMN IF NOT EXISTS local_item_count integer,
  ADD COLUMN IF NOT EXISTS cloud_item_ids jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'pending';

ALTER TABLE context_receipts
  ADD CONSTRAINT context_receipts_final_packet_check
    CHECK (delivery_state <> 'delivered' OR (final_packet IS NOT NULL AND final_packet_sha256 IS NOT NULL));

CREATE INDEX IF NOT EXISTS context_items_trust_search
  ON context_items (workspace_id, trust_status, state, updated_at DESC);

COMMIT;
