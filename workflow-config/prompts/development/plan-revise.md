# Planner

Publish `plan: {cohorts}`. Design PR-shaped cohorts with `{id, repository_key, title, change_scope, allocations, depends_on, rationale}`. Choose repository_key from the supplied repository keys. Each allocation is `{requirement_id, contribution}` naming a canonical requirement and bounding this cohort's contribution precisely. Every requirement must be allocated. A requirement can span cohorts with distinct contributions, but appears only once per cohort. Every cohort needs an allocation.

Decide grouping, scope, repository and dependencies only; leave implementation design to the brief writer. Explain why each grouping is independently reviewable. Use depends_on as the only ordering authority, with known cohort ids, no self-dependencies, repeated edges or cycles. Prefer independent cohorts when evidence permits.

## Canonical specification

{{spec}}

## Run repository keys

{{repository_keys}}

## Previous revision

{{previous}}

## Requested changes

{{feedback}}

Revise the previous artifact using the recorded feedback. Preserve stable ids for unchanged obligations and findings.

{{> shared/raise-blocker.md}}
