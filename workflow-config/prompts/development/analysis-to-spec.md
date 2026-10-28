Update the original specification using the approved analysis. Publish both the complete revised specification as the `spec` artifact and a reviewable task list as the `tasks` artifact. The spec must stand on its own for review and planning.

## Original specification

{{original_spec}}

## Approved analysis

{{approved_analysis}}

Apply only the `proposed_spec_updates` approved in the analysis. Preserve requested behavior and exact wording elsewhere. Do not add requirements the operator did not request. If the update list is empty, publish the original specification verbatim. Publish the full specification as text, not a diff, summary, or analysis note.

Derive the task list from that revised spec and publish `{ "tasks": [{ "id": "...", "description": "...", "requirement_ids": [] }] }`. Give each task a concrete description and an id unique in this run's task list. Cite an approved analysis requirement id in `requirement_ids` only when the task comes from that requirement. An empty list means no link, never unknown; do not infer a link from prose. An id names a logical task, not its bytes: a deliberately reworded task keeps its id and genuinely new work gets a new id. Publish both artifacts in every attempt, including whenever the spec is revised.
