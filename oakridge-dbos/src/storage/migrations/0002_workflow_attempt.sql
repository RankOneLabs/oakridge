CREATE TABLE oakridge.workflow_attempt (
  root_workflow_id text PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES oakridge.workflow_run(id) ON DELETE CASCADE,
  forked_from_root_workflow_id text REFERENCES oakridge.workflow_attempt(root_workflow_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO oakridge.workflow_attempt (root_workflow_id, run_id, forked_from_root_workflow_id, created_at)
SELECT run.root_workflow_id, run.id, parent.root_workflow_id, run.created_at
FROM oakridge.workflow_run run
LEFT JOIN oakridge.workflow_run parent ON parent.id = run.attempt_of;

ALTER TABLE oakridge.stage_instance ADD COLUMN attempt_root_workflow_id text;
UPDATE oakridge.stage_instance stage
SET attempt_root_workflow_id = run.root_workflow_id
FROM oakridge.workflow_run run
WHERE run.id = stage.run_id;
ALTER TABLE oakridge.stage_instance ALTER COLUMN attempt_root_workflow_id SET NOT NULL;
ALTER TABLE oakridge.stage_instance
  ADD CONSTRAINT stage_instance_attempt_root_workflow_id_fkey
  FOREIGN KEY (attempt_root_workflow_id) REFERENCES oakridge.workflow_attempt(root_workflow_id);
ALTER TABLE oakridge.stage_instance DROP CONSTRAINT stage_instance_run_id_stage_key_key;
ALTER TABLE oakridge.stage_instance ADD UNIQUE (attempt_root_workflow_id, stage_key);

ALTER TABLE oakridge.workflow_run DROP COLUMN attempt_of;
ALTER TABLE oakridge.workflow_run DROP COLUMN root_workflow_id;

CREATE INDEX workflow_attempt_run_created
  ON oakridge.workflow_attempt (run_id, created_at DESC);
