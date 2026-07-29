BEGIN;

ALTER TABLE connector_connections DROP CONSTRAINT connector_connections_provider_check;
ALTER TABLE connector_connections
  ADD CONSTRAINT connector_connections_provider_check
  CHECK (provider IN ('github', 'slack', 'linear'));

ALTER TABLE connector_oauth_states DROP CONSTRAINT connector_oauth_states_provider_check;
ALTER TABLE connector_oauth_states
  ADD CONSTRAINT connector_oauth_states_provider_check
  CHECK (provider IN ('github', 'slack', 'linear'));

COMMIT;
