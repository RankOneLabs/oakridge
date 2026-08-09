ALTER TABLE epic_repository_binding ADD COLUMN forge_provider TEXT;
ALTER TABLE epic_repository_binding ADD COLUMN forge_owner TEXT;
ALTER TABLE epic_repository_binding ADD COLUMN forge_name TEXT;

CREATE TABLE cohort_pull_request_reconciliation (
    workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    stage_instance_id TEXT NOT NULL REFERENCES stage_instance(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL,
    repository_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    pr_url TEXT NOT NULL,
    head_branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    head_sha TEXT,
    observed_state TEXT NOT NULL CHECK (observed_state IN ('open', 'merged', 'closed_unmerged')),
    observation_source TEXT NOT NULL CHECK (observation_source IN ('poll', 'webhook', 'manual_recheck')),
    observed_at TEXT NOT NULL,
    merged_at TEXT,
    mismatch_kind TEXT,
    mismatch_detail TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (stage_instance_id, unit_id),
    CHECK (
        (mismatch_kind IS NULL AND mismatch_detail IS NULL)
        OR (mismatch_kind IS NOT NULL AND mismatch_detail IS NOT NULL)
    )
);

CREATE INDEX cohort_pr_reconciliation_run
    ON cohort_pull_request_reconciliation(workflow_run_id);
