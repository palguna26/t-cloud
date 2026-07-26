BEGIN;

ALTER TABLE agent_sessions
  ADD COLUMN bound_work_thread_id uuid REFERENCES work_threads(id) ON DELETE SET NULL,
  ADD COLUMN binding_receipt_id uuid,
  ADD COLUMN binding_source text CHECK (binding_source IN ('explicit', 'resolved', 'clarified', 'handoff')),
  ADD COLUMN bound_at timestamptz;

ALTER TABLE context_receipts
  ADD COLUMN previous_receipt_id uuid REFERENCES context_receipts(id) ON DELETE SET NULL,
  ADD COLUMN receipt_type text NOT NULL DEFAULT 'initial'
    CHECK (receipt_type IN ('initial', 'delta', 'full_refresh', 'cached_fallback')),
  ADD COLUMN task_mode text NOT NULL DEFAULT 'general'
    CHECK (task_mode IN ('implement', 'investigate', 'review', 'verify', 'continue', 'general')),
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'expired')),
  ADD COLUMN failure_code text,
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes';

ALTER TABLE context_receipt_items
  ADD COLUMN section text,
  ADD COLUMN item_text_snapshot text,
  ADD COLUMN authority_snapshot smallint,
  ADD COLUMN confidence_snapshot real;

ALTER TABLE context_items
  ADD COLUMN supersedes_context_item_id uuid REFERENCES context_items(id) ON DELETE SET NULL,
  ADD COLUMN normalized_hash text,
  ADD COLUMN projector_version integer NOT NULL DEFAULT 1;

ALTER TABLE context_resolution_attempts
  ADD COLUMN candidate_choices_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN evidence_json jsonb NOT NULL DEFAULT '{}';

UPDATE context_receipts
SET receipt_type = 'initial',
    task_mode = 'general',
    delivery_status = CASE
      WHEN delivered_at IS NOT NULL OR acknowledged_at IS NOT NULL THEN 'delivered'
      ELSE 'expired'
    END,
    expires_at = created_at + interval '5 minutes';

UPDATE context_receipt_items
SET section = NULL,
    item_text_snapshot = COALESCE(source_snapshot_json->>'text', ''),
    authority_snapshot = (source_snapshot_json->>'authority')::smallint,
    confidence_snapshot = NULL;

ALTER TABLE context_receipts
  ADD CONSTRAINT context_receipts_delivery_delivered_at_check
    CHECK (delivery_status <> 'delivered' OR delivered_at IS NOT NULL),
  ADD CONSTRAINT context_receipts_delivery_failed_code_check
    CHECK (delivery_status <> 'failed' OR failure_code IS NOT NULL);

CREATE INDEX agent_sessions_bound_work_thread
  ON agent_sessions (workspace_id, bound_work_thread_id)
  WHERE bound_work_thread_id IS NOT NULL;
CREATE INDEX context_receipts_agent_session_created
  ON context_receipts (agent_session_id, created_at DESC);
CREATE INDEX context_receipts_work_thread_version
  ON context_receipts (work_thread_id, work_thread_version);
CREATE INDEX context_items_work_thread_state_type_updated
  ON context_items (work_thread_id, state, type, updated_at DESC);

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_binding_receipt_fk
  FOREIGN KEY (binding_receipt_id) REFERENCES context_receipts(id) ON DELETE SET NULL;

COMMIT;
