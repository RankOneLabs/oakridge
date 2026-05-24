-- Widen output_artifact_type CHECK to include 'assessment' (migration 011 pattern).
-- Stages has no foreign keys so no PRAGMA foreign_keys dance is needed.
CREATE TABLE stages_new (
  name TEXT PRIMARY KEY,
  prompt_template_path TEXT NOT NULL,
  input_artifact_type TEXT NOT NULL CHECK (input_artifact_type IN ('spec','cohort','brief','plan')),
  output_artifact_type TEXT NOT NULL CHECK (output_artifact_type IN ('plan','brief','pr','assessment')),
  gate TEXT NOT NULL CHECK (gate IN ('review_required','none')),
  default_backend TEXT NOT NULL
);
INSERT INTO stages_new (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend)
  SELECT name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend FROM stages;
DROP TABLE stages;
ALTER TABLE stages_new RENAME TO stages;

ALTER TABLE briefs ADD COLUMN deviations TEXT;

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  summary TEXT NOT NULL,
  deviations_catalog TEXT NOT NULL,
  gap_analysis TEXT NOT NULL,
  fix_plan TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX assessments_plan_id ON assessments(plan_id);

INSERT INTO stages (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend)
  VALUES ('planner3', 'planner3.md', 'plan', 'assessment', 'review_required', 'kbbl_chat');
