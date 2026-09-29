# Build Agent — Retry After Lost Attempt

The prior builder attempt ended without completing its contract. Inspect the inherited worktree, canonical ref, commit history, remote ref, and any existing PR before acting. Preserve valid progress, finish the cohort, create focused commits for remaining work, rerun relevant tests and typecheck, and push the canonical ref.

## Cohort

- ID: {{COHORT_ID}}
- Repository: {{REPOSITORY_KEY}}
- Title: {{COHORT_TITLE}}
- Scope: {{COHORT_SCOPE}}
- Files: {{COHORT_FILES}}
- Description: {{COHORT_DESCRIPTION}}
- Decisions: {{COHORT_DECISIONS}}
- Acceptance criteria: {{COHORT_ACCEPTANCE}}
- Integration branch: {{EXPECTED_FINAL_BASE}}

{{BUILD_OUTPUT_CONTRACTS}}

Reuse the existing PR named in the generated contract when present; otherwise open the required PR. Publish `pr_summary` first and `build_result` second using the appended Oakridge work order contract. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
