ALTER TABLE oakridge.stage_instance DROP CONSTRAINT stage_instance_attempt_root_workflow_id_fkey;
DROP TABLE oakridge.command_outbox;
DROP TABLE oakridge.executor_projection;
DROP TABLE oakridge.workflow_attempt;
