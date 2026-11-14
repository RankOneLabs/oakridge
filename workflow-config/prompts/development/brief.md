Write the build brief for one cohort of the accepted plan. Preserve the cohort's scope and decisions; do not implement code or invent requirements.

## The cohort

{{cohort}}

## Specification

{{spec}}

## What to publish

Publish the `brief` artifact for this cohort only.

Convert the cohort's assigned acceptance entries (task contributions) into `build_items`, each exactly `{ id, description, task_ids, decision_ids, verification }`. Give each build item an independent, unique id and describe specific code changes and observable behavior. Items may split one task or support several tasks. Link every assigned task, reference only assigned task ids, and link relevant decisions in `decisions_made`. Supply testable verification. Preserve scope without adding requirements; leave no obligation only in prose. The brief stands alone as the builder's complete contract, including exact required copy, values and source facts. Structural validation proves reference integrity, not semantic completeness.

Keep `cohort_id`, `repository_key`, `depends_on`, goal, files in scope, decisions and rejected approaches faithful to the cohort. Carry plan decision ids unchanged; new decisions receive new ids. Rejected approaches carry their own ids and decision links. Publish every brief field and never use placeholders or absolute paths.

Set `next_action` to the builder's immediate concrete first step. Preserve each decision's rationale so the builder understands why it was made.
