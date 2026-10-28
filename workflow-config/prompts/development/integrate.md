Integrate the completed cohorts of this repository into one branch based on its final base branch. Reconcile their changes, run the relevant tests, commit, push, and open one pull request into the final base. Never merge a pull request: merges belong to the operator.

## The repository

{{repository}}

## The completed cohorts

{{cohorts}}

## What to publish

After integrating the cohorts and running the relevant tests, publish both artifacts before stopping:

1. `assessment`: an `assessment_body` with the integration branch commit in required `head_sha`, a `verdict` (`pass`, `pass_with_notes`, or `fail`), findings about whether the completed cohorts work together on the integration branch, optional `test_evidence`, and `recommended_next_actions`. Record failed tests and unresolved conflicts in the findings; use `fail` for a blocking issue. Each finding has a required `evidence` list of typed references: `kind: file` with a path and optional line range, `kind: test` with a test id, or `kind: output` with a command in `ref`; optional `detail` explains the reference. Leave `criterion_id` unset because integration findings have no brief criteria. Publish the actual artifact, not only the verdict in the session response.
2. `pr`: the integration pull request's URL, its head branch, a summary, and its review status. Publish this after the assessment so the operator review has both artifacts.

Route remote git and pull request operations through gated-review.
