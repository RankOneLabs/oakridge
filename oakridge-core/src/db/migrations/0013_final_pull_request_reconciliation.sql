-- SQLite cannot alter a CHECK constraint in place. Rebuild the binding table
-- so the durable operator-visible state can distinguish an open final PR from
-- merged evidence that still requires external confirmation.
DROP INDEX epic_repository_binding_profile;
ALTER TABLE epic_repository_binding RENAME TO epic_repository_binding_v12;

CREATE TABLE epic_repository_binding (
    epic_profile_id TEXT NOT NULL
        REFERENCES epic_workflow_profile(id) ON DELETE CASCADE,
    repository_key TEXT NOT NULL CHECK (length(trim(repository_key)) > 0),
    repository_path TEXT NOT NULL CHECK (length(trim(repository_path)) > 0),
    base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
    epic_branch TEXT NOT NULL CHECK (length(trim(epic_branch)) > 0),
    final_merge_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (final_merge_state IN (
            'pending', 'pull_request_open', 'awaiting_confirmation',
            'merged', 'closed_without_merge'
        )),
    final_pr_number INTEGER,
    final_pr_url TEXT,
    final_pr_head_branch TEXT,
    final_pr_base_branch TEXT,
    forge_provider TEXT,
    forge_owner TEXT,
    forge_name TEXT,
    PRIMARY KEY (epic_profile_id, repository_key),
    CHECK (
        (final_pr_number IS NULL AND final_pr_url IS NULL
            AND final_pr_head_branch IS NULL AND final_pr_base_branch IS NULL)
        OR
        (final_pr_number IS NOT NULL AND final_pr_number > 0
            AND length(trim(final_pr_url)) > 0
            AND length(trim(final_pr_head_branch)) > 0
            AND length(trim(final_pr_base_branch)) > 0)
    )
);

INSERT INTO epic_repository_binding (
    epic_profile_id, repository_key, repository_path, base_branch, epic_branch,
    final_merge_state, final_pr_number, final_pr_url, final_pr_head_branch,
    final_pr_base_branch, forge_provider, forge_owner, forge_name
)
SELECT epic_profile_id, repository_key, repository_path, base_branch, epic_branch,
    final_merge_state, final_pr_number, final_pr_url, final_pr_head_branch,
    final_pr_base_branch, forge_provider, forge_owner, forge_name
FROM epic_repository_binding_v12;

DROP TABLE epic_repository_binding_v12;
CREATE INDEX epic_repository_binding_profile
    ON epic_repository_binding(epic_profile_id);

CREATE TABLE final_pull_request_reconciliation (
    epic_profile_id TEXT NOT NULL
        REFERENCES epic_workflow_profile(id) ON DELETE CASCADE,
    repository_key TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    mismatch_json TEXT,
    observed_at TEXT NOT NULL,
    merged_evidence_at TEXT,
    confirmation_idempotency_key TEXT,
    operator_comment TEXT,
    confirmed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (epic_profile_id, repository_key),
    FOREIGN KEY (epic_profile_id, repository_key)
        REFERENCES epic_repository_binding(epic_profile_id, repository_key)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX final_pull_request_confirmation_key
    ON final_pull_request_reconciliation(epic_profile_id, confirmation_idempotency_key)
    WHERE confirmation_idempotency_key IS NOT NULL;
