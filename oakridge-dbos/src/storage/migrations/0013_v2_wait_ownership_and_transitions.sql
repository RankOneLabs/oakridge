-- v2 wait ownership: branded run-unit/output-slot identity, kept alongside the
-- legacy stage/unit and execution-workflow columns a v1 wait still uses.
-- `command_workflow_id` stays the durable DBOS command address for both.
ALTER TABLE oakridge.wait
  ADD COLUMN run_unit_id uuid REFERENCES oakridge.run_unit(id),
  ADD COLUMN output_name text,
  ADD CONSTRAINT wait_v2_identity_shape CHECK ((run_unit_id IS NULL) = (output_name IS NULL));

-- At most one OPEN v2 wait per slot: mirrors the reciprocal invariant that a
-- pending slot names exactly one open wait.
CREATE UNIQUE INDEX wait_v2_open_slot ON oakridge.wait (run_unit_id, output_name)
  WHERE status = 'open' AND run_unit_id IS NOT NULL;

CREATE INDEX wait_v2_by_run_unit ON oakridge.wait (run_unit_id) WHERE run_unit_id IS NOT NULL;

-- The declared release policy travels with the slot, so publication and
-- closure decide immediate-vs-gated from the row already locked for the
-- transition rather than re-deriving it from the stage contract's outputs.
ALTER TABLE oakridge.run_output_slot ADD COLUMN release_policy jsonb;
UPDATE oakridge.run_output_slot SET release_policy = '{"kind":"immediate"}'::jsonb WHERE release_policy IS NULL;
ALTER TABLE oakridge.run_output_slot ALTER COLUMN release_policy SET NOT NULL;

-- Typed transition audit: one row per committed change a v2 workflow, operator,
-- or recovery path can ask about later, carrying the exact run-record version
-- boundary it crossed. Application-owned, so it never needs to be reconstructed
-- from DBOS event payloads or workflow return values.
CREATE TABLE oakridge.run_transition (
  id                        uuid PRIMARY KEY,
  run_id                    uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  run_unit_id               uuid REFERENCES oakridge.run_unit(id) ON DELETE CASCADE,
  work_order_id             uuid REFERENCES oakridge.work_order(id) ON DELETE CASCADE,
  wait_id                   uuid REFERENCES oakridge.wait(id),
  output_name               text,
  operation                 text NOT NULL CHECK (operation IN (
                              'slot_released', 'slot_pending', 'slot_invalidated',
                              'unit_satisfied', 'work_started'
                            )),
  actor                     text NOT NULL,
  prior_record_version      bigint NOT NULL CHECK (prior_record_version >= 0),
  resulting_record_version  bigint NOT NULL CHECK (resulting_record_version >= prior_record_version),
  detail                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL
);

CREATE INDEX run_transition_run_order ON oakridge.run_transition (run_id, resulting_record_version, created_at);
CREATE INDEX run_transition_run_unit ON oakridge.run_transition (run_unit_id, created_at) WHERE run_unit_id IS NOT NULL;
