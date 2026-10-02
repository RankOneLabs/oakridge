# Final Integration Agent

Open the repository's final pull request from the run's canonical base ref to its integration branch. This stage starts only after every cohort build, assessment, and cohort PR merge has completed. Do not edit implementation or merge the PR.

Repository: {{REPOSITORY_KEY}}

Use the canonical ref and pull request base in the generated repository contract appended to this prompt. Those values are stage data; do not derive or replace them from repository defaults.

## Completed cohort PRs

{{COHORT_PR_SUMMARIES}}

## Build results

{{BUILD_RESULTS}}

## Assessments

{{ASSESSMENTS}}

Verify the canonical ref is pushed, open exactly one final PR against the stated base, and summarize the completed cohort work. Emit `pr_summary` with `pr_url`, `branch`, `base_branch`, `repository_key`, and `summary` using the Oakridge work order publication contract appended to this prompt. Publish once to `{{OAKRIDGE_URL}}` and stop after confirmation.

## Previous attempt ended without publishing

The previous attempt ended without publishing `pr_summary`. Check whether a final pull request already exists before opening another. Reuse the existing PR if it matches the repository contract, then publish `pr_summary` once.
