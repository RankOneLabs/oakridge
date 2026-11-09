Revise your implementation plan.

## Your previous plan

{{previous}}

## What must change

{{feedback}}

## Specification

{{spec}}

## Approved task list

{{tasks}}

Set every cohort's `repository_key` to `{{repository_key}}`.

Publish the revised `plan` artifact with every field. Cohort ids are unique, and `depends_on` names other cohorts without a cycle.
Each cohort decision is `{ id, text }`, and each task acceptance entry in a cohort's `acceptance_criteria` is exactly `{ id, text, decision_ids }`. Decision ids are unique within their cohort. A deliberately reworded decision keeps its id, and a genuinely new decision gets a new one.
An entry's `id` is the `id` of a task on the approved task list, copied exactly. Every task appears in at least one cohort and at most once within a cohort; a task spanning cohorts keeps the same id in each. Fix a failed check by correcting the entries against the task list, never by renumbering, replacing or inventing an id. An entry's `text` keeps the task's actual obligation, or this cohort's contribution to it, rather than a test, typecheck, migration or process milestone. `decision_ids` cites the cohort decisions relied on; an empty list means no link, never unknown, and links must not be guessed from prose. An obligation no task covers goes in the plan's `risks` for the operator to decide.
The plan-wide `acceptance_criteria` stays a list of text.
