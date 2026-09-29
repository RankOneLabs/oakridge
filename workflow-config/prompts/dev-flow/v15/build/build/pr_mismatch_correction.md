# Build Agent — Pull Request Mismatch Correction

The implementation exists, but the recorded pull request does not match the canonical head or required base in the generated repository contract. Inspect the current ref and PR, correct its head/base/identity without broadening the cohort, and push any needed ref update. Change code only when required to make the canonical ref represent the accepted cohort revision.

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

Keep the existing PR when it can be corrected. Publish `pr_summary` first and `build_result` second using the appended Oakridge work order contract, describing the correction and verification. Stop only after both PUTs to `{{OAKRIDGE_URL}}` are confirmed.
