Plan the implementation from the accepted analysis, the specification and the prepared repositories.

## Specification

{{spec}}

## Accepted analysis

{{analysis}}

## Repositories

{{repositories}}

{{workspaces}}

Each cohort must operate in exactly one repository and must set
`repository_key` to a key from the repositories above. Dependencies may cross
repositories.

Repository topology is guaranteed before planning begins: the run's base
branch (each repository's `forge.build_base`) has already been prepared on
origin from that repository's final base (`forge.final_base`, typically
`main`). The prepare stage owns that guarantee, and the supplied branch values
are authoritative. Do not create, rebase, reset, or otherwise repair a branch
from this planner session. If the supplied topology does not look like the
above, record a blocking risk instead of planning around stale or unknown
ancestry.

The accepted analysis may identify genuine discrepancies between requested
features and the current code. Preserve those incompatibilities and their
resolutions in the plan. Do not reinterpret the ordinary fact that code must
change to satisfy the specification as a discrepancy: that before-to-after
difference is the work being planned.

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
- the `repository_key` of the repository it changes: one of the repository keys above
- `depends_on`: the ids of the cohorts that must merge before it starts, with no cycle
- its title, scope, files in scope, decisions and acceptance criteria

Name at least one cohort. Give a `dependency_order`, the scope in and out, the plan's acceptance criteria and its risks. A plan that breaks these rules is returned to you with what to fix.

Plan only; do not implement.
