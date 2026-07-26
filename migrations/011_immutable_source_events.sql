BEGIN;

CREATE TABLE source_entities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  entity_key text NOT NULL,
  current_source_event_id uuid,
  work_thread_id uuid REFERENCES work_threads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source, entity_key),
  UNIQUE (workspace_id, id)
);

ALTER TABLE source_events
  ADD COLUMN source_entity_id uuid REFERENCES source_entities(id) ON DELETE CASCADE,
  ADD COLUMN supersedes_source_event_id uuid REFERENCES source_events(id) ON DELETE SET NULL,
  ADD COLUMN provider_event_id text;

INSERT INTO source_entities (
  id, workspace_id, source, entity_key, current_source_event_id,
  work_thread_id, created_at, updated_at
)
SELECT gen_random_uuid(), workspace_id, source, external_id, id,
  work_thread_id, received_at, received_at
FROM source_events;

UPDATE source_events event
SET source_entity_id = entity.id
FROM source_entities entity
WHERE entity.workspace_id = event.workspace_id
  AND entity.source = event.source
  AND entity.entity_key = event.external_id;

ALTER TABLE source_entities ADD CONSTRAINT source_entities_current_event_fk
  FOREIGN KEY (current_source_event_id) REFERENCES source_events(id) ON DELETE SET NULL;

ALTER TABLE source_events
  DROP CONSTRAINT source_events_workspace_id_source_external_id_key;
CREATE UNIQUE INDEX source_events_agent_external_id
  ON source_events (workspace_id, source, external_id)
  WHERE connector_connection_id IS NULL;
CREATE UNIQUE INDEX source_events_provider_delivery
  ON source_events (workspace_id, source, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX source_events_entity_history
  ON source_events (source_entity_id, occurred_at DESC, received_at DESC);

CREATE FUNCTION reject_source_event_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Source Event is immutable';
END;
$$;

CREATE TRIGGER source_events_content_immutable
BEFORE UPDATE ON source_events
FOR EACH ROW EXECUTE FUNCTION reject_source_event_update();

COMMIT;
