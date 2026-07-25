BEGIN;

ALTER TABLE workspaces
  ADD COLUMN plan_override text
    CHECK (plan_override IN ('founding_partner', 'internal')),
  ADD COLUMN plan_override_expires_at timestamptz,
  ADD COLUMN plan_override_note text;

COMMIT;
