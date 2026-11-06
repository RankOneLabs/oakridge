Revise this repository's integration.

## Your previous integration pull request

{{previous}}

## What must change

{{feedback}}

## The repository

{{repository}}

## The completed cohorts

{{cohorts}}

## The task obligations

These are this repository's cohort briefs, and each brief's `acceptance_criteria` entries are its task obligations:

{{briefs}}

Group the entries by `id` to get the distinct tasks. An id in several briefs is one task whose work spans those cohorts: read every contribution together, and do not pick one brief or treat the repeat as an error. Assess every distinct task on the integration branch itself, not from the cohort build results.

Make the changes, run the relevant tests, commit and push. If the pull request was closed, open a new one as a draft (`draft: true`). Publish both artifacts again before stopping:

1. `assessment`: a complete `assessment_body` with the integration branch commit in required `head_sha`, the new `verdict`, findings about each distinct task and about the integration, optional `test_evidence`, and `recommended_next_actions`. Write narrow findings: each has a `description` stating one thing, a `status` of `met`, `not_met` or `partial`, and a required `task_ids` list of the task ids it addresses. A task may have several findings, a finding may address several tasks, and a finding about anything else has `task_ids: []`. Never infer a link from prose or invent an id. Describe evidence from this revision as a required list on each finding: each reference has `kind: file` and a path with optional line range, `kind: test` and a test id, or `kind: output` and a command in `ref`, plus optional `detail`. The assessment reviews the integration branch, so it has no build result subject. Publish the actual artifact, not only the verdict in the session response.
2. `pr`: the pull request's URL, head branch, summary, and review status. Publish this after the assessment so the operator review has both current artifacts.

Route remote git and pull request operations through gated-review.
