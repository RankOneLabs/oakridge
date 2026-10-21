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

1. `assessment`: a complete `assessment_body` with the new `verdict`, integration findings, optional `test_evidence`, and `recommended_next_actions`. Describe the evidence from this revision. Publish the actual artifact, not only the verdict in the session response.
2. `pr`: the pull request's URL, head branch, summary, and review status. Publish this after the assessment so the operator review has both current artifacts.

Route remote git and pull request operations through gated-review.
