Revise the build brief for this cohort.

## Your previous brief

{{previous}}

## What must change

{{feedback}}

## The cohort

{{cohort}}

## Specification

{{spec}}

Publish the revised `brief` artifact with every field. Keep its `cohort_id`, `repository_key` and `depends_on` exactly as the cohort has them.
Make each acceptance criterion self-contained. Carry exact copy, labels, values, and source facts required for this cohort into the brief itself; do not refer the builder or assessor back to the specification for missing details.
Keep every criterion's plan cohort `id`, `task_ids`, and `decision_ids` unchanged even when rewriting its text. Keep plan decision ids in `decisions_made`; give a decision without a plan source a new id. Each rejected approach has its own id and `decision_ids` for decisions it lost to. Rejected approaches have no upstream plan item, which is expected. Empty id lists mean no link; never infer one from prose. A deliberately reworded logical item keeps its id and a genuinely new item gets a new one. Decision and criterion ids are unique within the cohort.
