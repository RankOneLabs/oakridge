ALTER TABLE acp_sessions ADD COLUMN cohort_id TEXT;
CREATE INDEX acp_sessions_durable_cohort_idx ON acp_sessions(workflow_run_id, cohort_id);
