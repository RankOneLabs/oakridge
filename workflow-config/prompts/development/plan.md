Plan the implementation from the approved specification and the repository in the current directory.

## Specification

{{spec}}

## Approved task list

{{tasks}}

Set every cohort's `repository_key` to `{{repository_key}}`. The run's base
branch has already been prepared on origin. Do not create, rebase, reset, or
repair it from this planner session.

## Cohort sizing and review

A cohort is an implementation and pull request review unit. Choose boundaries
for both functional coherence and thorough review of the complete diff.
Functional isolation alone is not a reason to create another cohort.

- Start with one cohort per repository involved in the change. Split further
  only when the expected diff would be too large or cognitively broad to review
  thoroughly, or when a concrete dependency, risk, or rollout boundary warrants
  a separate pull request. Each cohort must leave tests passing and typecheck
  clean.
- Combine small, isolated changes in the same repository into one cohort when a
  reviewer can understand and fully review them together. Do not create a
  cohort per helper, file, requirement, architectural layer, or test update
  merely because each could be implemented independently.
- Keep implementation, its tests, and the small documentation or wiring changes
  needed to verify it together. For example, a helper, its caller adaptation,
  tests, and two small related fixes can share one cohort; separate model, API,
  and UI cohorts are unnecessary when their combined diff is readily reviewable.
- Avoid a series of roughly 20-line pull requests. Lines of code are a signal,
  not a quota: neither pad tiny changes nor combine work into a diff too broad
  to review. A tiny standalone cohort needs a concrete repository, risk,
  dependency, or rollout reason that outweighs the extra review and merge
  overhead.
- Before publishing, consolidate cohorts whose combined diff remains readily
  reviewable. For every remaining split within a repository, explain its
  review, dependency, risk, or rollout rationale in the cohort's `description`.
  Remove dependencies that existed only because small tasks were unnecessarily
  split.

## What to publish

Publish the `plan` artifact. Split the work into cohorts, each with:

- a stable `id`: an identifier with no `/` or `\`, unique in the plan
- `repository_key`: the key supplied above
- `depends_on`: the ids of the cohorts that must merge before it starts, with no cycle
- its title, scope, files in scope, decisions and task acceptance entries in `acceptance_criteria`

Give every decision an `id` unique within its cohort. A decision has `{ id, text }`: a deliberately reworded decision keeps its id, and a genuinely new decision gets a new one. A task acceptance entry has exactly `{ id, text, decision_ids }`.

The approved task list is the only source of acceptance ids. Each entry's `id` is the `id` of one task on that list, copied exactly, and it identifies the same task through planning, briefing, assessment and integration. Do not allocate any other id for an entry, and do not qualify a task id with its cohort.

- Every task appears in at least one cohort.
- A task appears at most once within a cohort.
- A task whose work spans cohorts appears in each of them under the same id: `T7` stays `T7` in cohorts A and B. Repeating an id across cohorts is expected.

An entry's `text` states the task's actual obligation, or this cohort's contribution to it when the work is split. Keep the obligation when you reword it. Do not replace it with a test count, a typecheck, a migration, a process milestone or a narrower restatement; those belong in the cohort's scope as verification. `decision_ids` cites the cohort decisions the entry rests on. An empty list means no link, never an unknown link; do not infer links from prose. If the work needs an obligation that no task covers, say so in the plan's `risks` for the operator to decide. Do not invent a task id for it.

The plan-wide `acceptance_criteria` remains a list of text.

Name at least one cohort. Give a `dependency_order`, the scope in and out, the plan's acceptance criteria and its risks. A plan that breaks these rules is returned to you with what to fix, and it cannot be accepted until a corrected revision passes.

Plan only; do not implement.

Terminology: **spec tasks** are the overall obligations explicitly written in the approved spec and mirrored by the tasks artifact. A cohort acceptance entry is a **cohort contribution** to that spec task, using the same id, not a new task. Several cohorts may contribute to one spec task; their combined contributions must cover its full obligation. A brief preserves its cohort's assigned contribution and supplies enough detail to implement it.
