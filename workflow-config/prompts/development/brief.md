Write the build brief for one cohort of the accepted plan. Preserve the cohort's scope and decisions; do not implement code or invent requirements.

## The cohort

{{cohort}}

## Specification

{{spec}}

## What to publish

Publish the `brief` artifact for this cohort only. Keep its `cohort_id`, `repository_key` and `depends_on` exactly as the cohort has them. Carry forward its decisions with their rationale, the approaches rejected and why, the files in scope and the acceptance criteria, and state the goal and the builder's immediate, concrete first build step as its next action.

Carry every plan cohort criterion's `id`, `task_ids`, and `decision_ids` unchanged into the brief's `acceptance_criteria`, even when you rewrite its `text` to be self-contained. Carry each plan decision's `id` unchanged into `decisions_made`; give a brief decision with no plan source a new id. Give each `approaches_rejected` item a unique id and `decision_ids` naming the decisions it lost to. A rejected approach has no plan source and therefore no upstream item; that is expected, not a missing link. Empty id lists mean no link, never unknown; do not infer links from prose. Ids name logical items, so deliberate rewording keeps the id and genuinely new items get new ids. Decision and criterion ids are unique within this cohort.

The brief is the builder's complete scope and the assessor's sole requirement source. Make each acceptance criterion self-contained. When the specification requires exact copy, labels, values, or other source facts for this cohort, include those exact values in the brief's acceptance criteria or decisions. Do not refer the builder or assessor back to the specification for missing details.

Every field is required. Arrays may be empty when the cohort and specification contain no corresponding item. Never use placeholders or absolute paths.
