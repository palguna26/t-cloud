BEGIN;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY provider, external_account_id ORDER BY created_at, id
  ) AS position
  FROM connector_connections
  WHERE status = 'active'
)
UPDATE connector_connections connection
SET status = 'revoked', revoked_at = now(), updated_at = now(),
    credentials_ciphertext = NULL,
    last_error = 'Revoked because this provider account was active in another workspace'
FROM ranked
WHERE connection.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX connector_active_account_unique
  ON connector_connections (provider, external_account_id)
  WHERE status = 'active';

ALTER TABLE source_records
  ADD CONSTRAINT source_records_workspace_id_id_unique UNIQUE (workspace_id, id);
ALTER TABLE work_threads
  ADD CONSTRAINT work_threads_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE work_thread_evidence ADD COLUMN workspace_id uuid;
UPDATE work_thread_evidence evidence
SET workspace_id = thread.workspace_id
FROM work_threads thread
WHERE thread.id = evidence.work_thread_id;
ALTER TABLE work_thread_evidence ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE work_thread_evidence
  ADD CONSTRAINT work_thread_evidence_workspace_thread_fk
    FOREIGN KEY (workspace_id, work_thread_id) REFERENCES work_threads(workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT work_thread_evidence_workspace_source_fk
    FOREIGN KEY (workspace_id, source_record_id) REFERENCES source_records(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE claims
  ADD CONSTRAINT claims_workspace_thread_fk
    FOREIGN KEY (workspace_id, work_thread_id) REFERENCES work_threads(workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT claims_workspace_source_fk
    FOREIGN KEY (workspace_id, source_record_id) REFERENCES source_records(workspace_id, id) ON DELETE CASCADE;

COMMIT;
