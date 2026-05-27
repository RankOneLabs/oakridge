-- Register planner0 stage and widen output_artifact_type CHECK to include 'discrepancies'.
-- Uses the same 12-step table-rebuild pattern as migrations 011 and 012.
CREATE TABLE stages_new (
  name TEXT PRIMARY KEY,
  prompt_template_path TEXT NOT NULL,
  input_artifact_type TEXT NOT NULL CHECK (input_artifact_type IN ('spec','cohort','brief','plan')),
  output_artifact_type TEXT NOT NULL CHECK (output_artifact_type IN ('plan','brief','pr','assessment','discrepancies')),
  gate TEXT NOT NULL CHECK (gate IN ('review_required','none')),
  default_backend TEXT NOT NULL
);
INSERT INTO stages_new (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend)
  SELECT name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend FROM stages;
DROP TABLE stages;
ALTER TABLE stages_new RENAME TO stages;

INSERT INTO stages (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend)
  VALUES ('planner0', 'planner0.md', 'spec', 'discrepancies', 'review_required', 'kbbl_chat');
