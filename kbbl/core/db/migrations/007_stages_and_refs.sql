CREATE TABLE stages (
  name TEXT PRIMARY KEY,
  prompt_template_path TEXT NOT NULL,
  input_artifact_type TEXT NOT NULL CHECK (input_artifact_type IN ('spec','cohort','brief')),
  output_artifact_type TEXT NOT NULL CHECK (output_artifact_type IN ('plan','brief','pr')),
  gate TEXT NOT NULL CHECK (gate IN ('review_required','none')),
  default_backend TEXT NOT NULL
);

ALTER TABLE specs ADD COLUMN current_session_ref TEXT;
ALTER TABLE cohorts ADD COLUMN current_session_ref TEXT;
ALTER TABLE briefs ADD COLUMN pr_url TEXT;
