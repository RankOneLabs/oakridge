Revise the published specification and task list in response to the operator's request-changes feedback, whether the feedback concerns `spec` or `tasks`. Publish the complete `spec` text and `tasks` body in every attempt. When only the task list needs changes, republish the unchanged spec; when the spec changes, derive and republish the task list from it. Both revisions receive fresh review states, even when one body is unchanged. Keep the spec consistent with the approved analysis and its proposed spec updates. Preserve the rest of the specification.

## Previous reviewed artifact

{{previous}}

The handoff lists the latest revisions of both `spec` and `tasks`. Use them to preserve the artifact that feedback did not ask to change.

## Operator feedback

{{feedback}}

## Original specification

{{original_spec}}

## Approved analysis

{{approved_analysis}}

Give each task a concrete description and an id unique in this run's task list. Cite approved analysis requirement ids in `requirement_ids` only when the task comes from them. An empty list means no link, never unknown; do not infer links from prose. An id names a logical task, not its bytes: a deliberately reworded task keeps its id and genuinely new work gets a new id.
