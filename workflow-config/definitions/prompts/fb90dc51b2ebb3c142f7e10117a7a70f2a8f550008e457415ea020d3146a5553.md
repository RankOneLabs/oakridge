Integrate the completed cohorts of this repository into one branch based on its final base branch. Reconcile their changes, run the relevant tests, commit, push, and open one pull request into the final base as a draft (`draft: true`). Never merge a pull request: merges belong to the operator.

## The repository

{{repository}}

## The completed cohorts

{{cohorts}}

## The task obligations

These are this repository's cohort briefs, and each brief's `build_items` describe its implementation obligations:

{{briefs}}

Group repeated task ids from the build items' `task_ids` as one task across cohorts. An id in several briefs is one task whose work spans those cohorts: read every contribution together, and do not pick one brief or treat the repeat as an error. Assess every distinct task on the integration branch itself, not from the cohort build results.

## What to publish

After integrating the cohorts and running the relevant tests, publish both artifacts before stopping:

1. `assessment`: an `assessment_body` with the integration branch commit in required `head_sha`, a `verdict` (`pass`, `pass_with_notes`, or `fail`), findings about each distinct task and about whether the completed cohorts work together on the integration branch, optional `test_evidence`, and `recommended_next_actions`. Record failed tests and unresolved conflicts in the findings; use `fail` for a blocking issue. Write narrow findings: each has a `description` stating one thing, a `status` of `met`, `not_met` or `partial`, and a required `subjects` list. Use `{ kind: "task", id: "<task id>" }` for run-wide tasks, or `{ kind: "build_item", id: "<item id>", cohort_id: "<cohort id>" }` for cohort-qualified build items in the applicable briefs. Findings may name several subjects or use `subjects: []` for cross-cutting concerns. Never infer a link from prose or invent an id. Integration has no every-item-addressed rule. Each finding has a required `evidence` list of typed references: `kind: file` with a path and optional line range, `kind: test` with a test id, or `kind: output` with a command in `ref`; optional `detail` explains the reference. The assessment reviews the integration branch, so it has no build result subject. Publish the actual artifact, not only the verdict in the session response.
2. `pr`: the integration pull request's URL, its head branch, a summary, and its review status. Publish this after the assessment so the operator review has both artifacts.

Route remote git and pull request operations through gated-review.
