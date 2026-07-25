BEGIN;

ALTER TABLE workspaces
  ADD COLUMN context_delivery_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agent_identities
  ADD COLUMN context_delivery_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE work_threads
  ADD COLUMN context_delivery_enabled boolean NOT NULL DEFAULT true;

COMMIT;
