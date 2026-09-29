# Build Agent — Replacement Pull Request

The existing pull request cannot continue and Oakridge has authorized a replacement. Inspect the canonical cohort ref and rejected PR, ensure the ref contains the accepted cohort revision, then open exactly one replacement PR from the canonical ref to the base named in the generated repository contract. Do not reuse or silently retarget the rejected PR.

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

Change implementation only if needed to restore the accepted revision. Publish the replacement `pr_summary` first and `build_result` second using the appended Oakridge work order contract, clearly identifying the new PR. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
