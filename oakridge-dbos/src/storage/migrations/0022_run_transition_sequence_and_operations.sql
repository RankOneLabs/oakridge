-- A cross-run feed cannot use resulting_record_version: that counter is local
-- to one run. This sequence is only a best-effort toast cursor: bigserial
-- allocation is not transactional, so durable state still comes from reads.
ALTER TABLE oakridge.run_transition ADD COLUMN sequence bigserial;
CREATE UNIQUE INDEX run_transition_sequence ON oakridge.run_transition (sequence);

ALTER TABLE oakridge.run_transition DROP CONSTRAINT run_transition_operation_check;
ALTER TABLE oakridge.run_transition ADD CONSTRAINT run_transition_operation_check
  CHECK (operation IN (
    'stage_materialized', 'materialization_closed', 'materialization_failed', 'run_cancelled', 'unit_admitted',
    'slot_released', 'slot_pending', 'slot_invalidated',
    'unit_satisfied', 'work_started', 'input_revised', 'operator_retry_created',
    'gate_opened', 'gate_decided', 'pull_request_observed', 'pull_request_merge_confirmed'
  ));
