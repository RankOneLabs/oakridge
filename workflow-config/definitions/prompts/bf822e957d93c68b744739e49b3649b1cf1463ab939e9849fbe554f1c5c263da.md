Revise the published specification and task list in response to the operator's request-changes feedback, whether the feedback concerns `spec` or `tasks`. Publish the complete `spec` text first and then its mirrored `tasks` body in every attempt. The revised spec contains the canonical **Spec tasks** section: stable task ids, complete descriptions and explicit requirement ids. The `tasks` artifact mirrors that section exactly. When task feedback changes an entry, revise the same entry in the spec and republish both artifacts; preserve unrelated spec text. When the spec changes, update its explicit tasks first and mirror them into the task list. Do not maintain a second independently derived list. Both revisions receive fresh review states, even when one body is unchanged. Keep the spec consistent with the approved analysis and its proposed spec updates. Preserve the rest of the specification.

## Previous reviewed artifact

{{previous}}

The handoff lists the latest revisions of both `spec` and `tasks`. Use them to preserve the artifact that feedback did not ask to change.

## Operator feedback

{{feedback}}

## Original specification

{{original_spec}}

## Approved analysis

{{approved_analysis}}

Tasks are code changes only: each one describes a change visible in the repository diff. Tests belong to the code task they cover. Do not list test runs, proof runs, deployment, cutover or other process steps as tasks; they stay in the spec. Give each task a concrete description and an id unique in this run's task list. Cite approved analysis requirement ids in `requirement_ids` only when the task comes from them. An empty list means no link, never unknown; do not infer links from prose. An id names a logical task, not its bytes: a deliberately reworded task keeps its id and genuinely new work gets a new id.
