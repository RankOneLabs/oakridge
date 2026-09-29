# Build Agent — Initial Build

Implement exactly this cohort in the prepared worktree. Create focused commits, run the relevant tests and typecheck, push the canonical cohort ref named in the generated repository contract, and open one pull request against its stated base.

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

Do not change scope or branch roles. After the PR exists, publish `pr_summary` first and `build_result` second using the Oakridge work order publication contract appended to this prompt. The result must list changed files, test counts and output, cohort metadata, and known issues. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
