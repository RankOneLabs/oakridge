ALTER TABLE oakridge.run_transition DROP CONSTRAINT run_transition_operation_check;
ALTER TABLE oakridge.run_transition ADD CONSTRAINT run_transition_operation_check
  CHECK (operation IN (
    'stage_materialized', 'materialization_closed', 'materialization_failed', 'run_cancelled', 'unit_admitted',
    'slot_released', 'slot_pending', 'slot_invalidated',
    'unit_satisfied', 'work_started', 'input_revised', 'operator_retry_created'
  ));
