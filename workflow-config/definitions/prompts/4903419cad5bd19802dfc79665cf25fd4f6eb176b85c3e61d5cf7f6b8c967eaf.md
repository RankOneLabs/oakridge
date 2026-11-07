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
Make each acceptance entry self-contained. Carry exact copy, labels, values, and source facts required for this cohort into the brief itself; do not refer the builder or assessor back to the specification for missing details.
Keep every plan cohort acceptance entry as exactly `{ id, text, decision_ids }`, in the same order, with its `id` and `decision_ids` unchanged even when rewriting its text. The `id` is the task's id: fix a failed check by restoring the cohort's ids, never by adding, dropping, replacing or reordering one. Rewritten text keeps the task's actual obligation rather than a test count, typecheck, migration or process milestone. Keep plan decision ids in `decisions_made`; give a decision without a plan source a new id. Each rejected approach has its own id and `decision_ids` for decisions it lost to. Rejected approaches have no upstream plan item, which is expected. Empty id lists mean no link; never infer one from prose. A deliberately reworded decision keeps its id and a genuinely new decision gets a new one. Decision ids are unique within the cohort.
