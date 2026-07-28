BEGIN;

ALTER TABLE alpha_source_records RENAME TO source_records;
ALTER TABLE alpha_agent_sessions RENAME TO agent_sessions;
ALTER TABLE alpha_memories RENAME TO memories;
ALTER TABLE alpha_memory_sources RENAME TO memory_sources;

ALTER TABLE source_records RENAME COLUMN provider TO source_type;
ALTER TABLE source_records RENAME COLUMN repository TO repository_id;
ALTER TABLE source_records RENAME COLUMN created_at TO ingested_at;
ALTER TABLE source_records ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE source_records DROP CONSTRAINT alpha_source_records_provider_check;
ALTER TABLE source_records ADD CONSTRAINT source_records_source_type_check CHECK (source_type IN ('slack', 'github')) NOT VALID;
ALTER TABLE source_records
  ADD CONSTRAINT source_records_parent_record_id_fkey
  FOREIGN KEY (parent_record_id) REFERENCES source_records(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE source_records RENAME CONSTRAINT alpha_source_records_workspace_id_fkey TO source_records_workspace_id_fkey;
ALTER TABLE source_records RENAME CONSTRAINT alpha_source_records_workspace_id_provider_external_id_key TO source_records_external_id_unique;
ALTER INDEX alpha_source_records_pkey RENAME TO source_records_pkey;
ALTER INDEX alpha_source_records_lookup RENAME TO source_records_lookup;

ALTER TABLE agent_sessions RENAME COLUMN agent TO agent_type;
ALTER TABLE agent_sessions RENAME COLUMN repository TO repository_id;
ALTER TABLE agent_sessions RENAME COLUMN completion_status TO status;
ALTER TABLE agent_sessions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_sessions RENAME CONSTRAINT alpha_agent_sessions_agent_check TO agent_sessions_agent_type_check;
UPDATE agent_sessions SET status = COALESCE(status, CASE WHEN completed_at IS NULL THEN 'active' ELSE 'completed' END);
ALTER TABLE agent_sessions ALTER COLUMN status SET NOT NULL;
ALTER TABLE agent_sessions RENAME CONSTRAINT alpha_agent_sessions_workspace_id_fkey TO agent_sessions_workspace_id_fkey;
ALTER TABLE agent_sessions RENAME CONSTRAINT alpha_agent_sessions_workspace_id_external_session_id_key TO agent_sessions_external_id_unique;
ALTER INDEX alpha_agent_sessions_pkey RENAME TO agent_sessions_pkey;

ALTER TABLE memories RENAME COLUMN repository TO repository_id;
ALTER TABLE memories ADD COLUMN work_thread_id text;
ALTER TABLE memories RENAME CONSTRAINT alpha_memories_memory_type_check TO memories_memory_type_check;
UPDATE memories SET status = 'unknown' WHERE status NOT IN ('active', 'superseded', 'completed', 'unknown');
ALTER TABLE memories ADD CONSTRAINT memories_status_check CHECK (status IN ('active', 'superseded', 'completed', 'unknown'));
ALTER TABLE memories RENAME CONSTRAINT alpha_memories_workspace_id_fkey TO memories_workspace_id_fkey;
ALTER TABLE memories RENAME CONSTRAINT alpha_memories_confidence_check TO memories_confidence_check;
ALTER INDEX alpha_memories_pkey RENAME TO memories_pkey;
CREATE INDEX memories_lookup ON memories (workspace_id, repository_id, status, event_at DESC);

ALTER TABLE memory_sources DROP CONSTRAINT alpha_memory_sources_pkey;
ALTER TABLE memory_sources ALTER COLUMN source_record_id DROP NOT NULL;
ALTER TABLE memory_sources ADD CONSTRAINT memory_sources_has_source_check CHECK (source_record_id IS NOT NULL OR agent_session_id IS NOT NULL);
ALTER TABLE memory_sources RENAME CONSTRAINT alpha_memory_sources_memory_id_fkey TO memory_sources_memory_id_fkey;
ALTER TABLE memory_sources RENAME CONSTRAINT alpha_memory_sources_source_record_id_fkey TO memory_sources_source_record_id_fkey;
ALTER TABLE memory_sources RENAME CONSTRAINT alpha_memory_sources_agent_session_id_fkey TO memory_sources_agent_session_id_fkey;
CREATE UNIQUE INDEX memory_sources_record_unique ON memory_sources (memory_id, source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX memory_sources_session_unique ON memory_sources (memory_id, agent_session_id) WHERE agent_session_id IS NOT NULL;

COMMIT;
