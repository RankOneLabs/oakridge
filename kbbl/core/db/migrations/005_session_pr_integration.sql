ALTER TABLE acp_sessions ADD COLUMN pr_integration TEXT NOT NULL DEFAULT 'none' CHECK (pr_integration IN ('gated-review', 'github-cli', 'none'));
ALTER TABLE acp_sessions ADD COLUMN pr_skill_digest TEXT;
UPDATE acp_sessions SET pr_integration = 'gated-review' WHERE run_id IS NOT NULL;
