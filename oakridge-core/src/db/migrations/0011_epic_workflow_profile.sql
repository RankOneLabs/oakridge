-- Typed, durable dev-flow Epic projection. Generic workflow runs remain the
-- execution substrate; this table provides the operator-domain identity.
CREATE TABLE epic_workflow_profile (
    id TEXT NOT NULL PRIMARY KEY,
    workflow_run_id TEXT NOT NULL UNIQUE
        REFERENCES workflow_run(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    slug TEXT NOT NULL CHECK (length(trim(slug)) > 0),
    lifecycle_state TEXT NOT NULL
        CHECK (lifecycle_state IN ('draft', 'active', 'final_integration', 'completed', 'failed')),
    final_merge_policy TEXT NOT NULL
        CHECK (final_merge_policy IN ('guarded', 'external_confirmation')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE epic_repository_binding (
    epic_profile_id TEXT NOT NULL
        REFERENCES epic_workflow_profile(id) ON DELETE CASCADE,
    repository_key TEXT NOT NULL CHECK (length(trim(repository_key)) > 0),
    repository_path TEXT NOT NULL CHECK (length(trim(repository_path)) > 0),
    base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
    epic_branch TEXT NOT NULL CHECK (length(trim(epic_branch)) > 0),
    final_merge_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (final_merge_state IN (
            'pending', 'pull_request_open', 'merged', 'closed_without_merge'
        )),
    final_pr_number INTEGER,
    final_pr_url TEXT,
    final_pr_head_branch TEXT,
    final_pr_base_branch TEXT,
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

CREATE INDEX epic_repository_binding_profile
    ON epic_repository_binding(epic_profile_id);
