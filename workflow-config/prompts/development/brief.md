Write the build brief for one cohort of the accepted plan. Preserve the cohort's scope and decisions; do not implement code or invent requirements.

## The cohort

{{cohort}}

## Specification

{{spec}}

## What to publish

Publish the `brief` artifact for this cohort only. Keep its `cohort_id`, `repository_key` and `depends_on` exactly as the cohort has them. Carry forward its decisions with their rationale, the approaches rejected and why, the files in scope and the acceptance criteria, and state the goal and the builder's immediate, concrete first build step as its next action.

Carry every plan cohort acceptance entry into the brief's `acceptance_criteria` as exactly `{ id, text, decision_ids }`, in the same order, with its `id` and `decision_ids` unchanged. The `id` is the task's id: never add, drop, replace or reorder one. You may rewrite `text` to be self-contained and to explain this cohort's contribution, but it must keep the task's actual obligation; do not narrow it to a test count, typecheck, migration or process milestone. Carry each plan decision's `id` unchanged into `decisions_made`; give a brief decision with no plan source a new id. Give each `approaches_rejected` item a unique id and `decision_ids` naming the decisions it lost to. A rejected approach has no plan source and therefore no upstream item; that is expected, not a missing link. Empty id lists mean no link, never unknown; do not infer links from prose. Decision ids name logical items, so deliberate rewording keeps the id and genuinely new decisions get new ids. Decision ids are unique within this cohort. A task id may also appear in another cohort's brief; that is expected.

The brief is the builder's complete scope and the assessor's sole requirement source. Make each acceptance entry self-contained. When the specification requires exact copy, labels, values, or other source facts for this cohort, include those exact values in the brief's acceptance entries or decisions. Do not refer the builder or assessor back to the specification for missing details.

Every field is required. Arrays may be empty when the cohort and specification contain no corresponding item. Never use placeholders or absolute paths.
