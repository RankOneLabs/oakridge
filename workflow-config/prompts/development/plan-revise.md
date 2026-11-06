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
Each cohort decision is `{ id, text }`, and each cohort acceptance criterion is `{ id, text, decision_ids }`. A criterion's `id` is the exact id of the approved task it serves; a task served by several cohorts repeats that id in each, and a cohort lists a task id at most once. Decision ids are unique within their cohort. Cite the cohort decision ids relied on; an empty id list means no link, never unknown, and links must not be guessed from prose. Keep an id when deliberately rewording the same logical item; give a genuinely new item a new id. The plan-wide `acceptance_criteria` stays a list of text.
