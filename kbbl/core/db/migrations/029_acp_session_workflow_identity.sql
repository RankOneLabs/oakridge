-- Give a kbbl session the cohort identity it has no field for today.
--
-- oakridge resolves a v2 delegated session against a workflow run, stage
-- instance, and fan-out unit; none of that survived the trip into kbbl's
-- own session row, so the session list could not group a cohort's build
-- and assessment sessions together. All six columns are nullable: a
-- hand-started POST /sessions session, and every session that predates
-- this migration, carries no identity at all.

ALTER TABLE acp_sessions ADD COLUMN workflow_run_id TEXT;
ALTER TABLE acp_sessions ADD COLUMN stage_instance_id TEXT;
ALTER TABLE acp_sessions ADD COLUMN stage_unit_id TEXT;
ALTER TABLE acp_sessions ADD COLUMN operator_role TEXT;
ALTER TABLE acp_sessions ADD COLUMN cohort_title TEXT;
ALTER TABLE acp_sessions ADD COLUMN repository_key TEXT;

CREATE INDEX acp_sessions_cohort_idx ON acp_sessions(workflow_run_id, stage_unit_id);
