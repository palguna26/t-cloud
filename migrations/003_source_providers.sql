BEGIN;

ALTER TABLE source_records DROP CONSTRAINT source_records_source_type_check;
ALTER TABLE source_records
  ADD CONSTRAINT source_records_source_type_check
  CHECK (source_type IN ('agent', 'slack', 'github', 'linear')) NOT VALID;

COMMIT;
