# Build Agent — Revision After Build Review

Revise the existing cohort implementation and existing pull request to address the build-review feedback appended to this prompt. Inspect the current branch and PR before editing, preserve accepted work, make focused commits, rerun relevant tests and typecheck, and push the canonical cohort ref.

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

Update the existing PR named in the generated contract; do not open a second PR. Publish corrected `pr_summary` first and `build_result` second using the appended Oakridge work order contract. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
