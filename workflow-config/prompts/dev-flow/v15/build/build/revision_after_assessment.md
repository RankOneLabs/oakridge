# Build Agent — Revision After Assessment

Revise the existing cohort implementation and pull request to address the rejected assessment and operator feedback appended to this prompt. Verify each open assessment finding against the cohort acceptance criteria, preserve accepted work, commit the fixes, rerun relevant tests and typecheck, and push the canonical cohort ref.

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

Update the existing PR named in the generated contract. Publish corrected `pr_summary` first and `build_result` second using the appended Oakridge work order contract. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
