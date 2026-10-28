Revise this repository's integration.

## Your previous integration pull request

{{previous}}

## What must change

{{feedback}}

## The repository

{{repository}}

## The completed cohorts

{{cohorts}}

Make the changes, run the relevant tests, commit and push. If the pull request was closed, open a new one. Publish both artifacts again before stopping:

1. `assessment`: a complete `assessment_body` with the integration branch commit in required `head_sha`, the new `verdict`, integration findings, optional `test_evidence`, and `recommended_next_actions`. Describe evidence from this revision as a required list on each finding: each reference has `kind: file` and a path with optional line range, `kind: test` and a test id, or `kind: output` and a command in `ref`, plus optional `detail`. Leave `criterion_id` unset because integration findings have no brief criteria. Publish the actual artifact, not only the verdict in the session response.
2. `pr`: the pull request's URL, head branch, summary, and review status. Publish this after the assessment so the operator review has both current artifacts.

Route remote git and pull request operations through gated-review.
