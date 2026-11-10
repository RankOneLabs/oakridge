Update the original specification using the approved analysis. Publish both the complete revised specification as the `spec` artifact and a reviewable task list as the `tasks` artifact. The spec must stand on its own for review and planning.

## Original specification

{{original_spec}}

## Approved analysis

{{approved_analysis}}

Apply only the `proposed_spec_updates` approved in the analysis. Preserve requested behavior and exact wording elsewhere. Do not add requirements the operator did not request. Preserve the original specification verbatim outside the explicit Spec tasks section when the update list is empty. Publish the full specification as text, not a diff, summary, or analysis note.

Write an explicit **Spec tasks** section in the revised specification. Each entry states a stable task id, its full description, and its explicit analysis requirement ids. This section is the canonical task list and is reviewed as part of the spec; it introduces no obligations beyond the requested behavior and approved updates. The separate `tasks` artifact mirrors those entries exactly, with no extra or missing tasks and no independently rewritten descriptions or links. Publish `{ "tasks": [{ "id": "...", "description": "...", "requirement_ids": [] }] }`. Tasks are code changes only: each one describes a change visible in the repository diff. Tests belong to the code task they cover. Do not list test runs, proof runs, deployment, cutover or other process steps as tasks; they stay in the spec. Give each task a concrete description and an id unique in this run's task list. Cite an approved analysis requirement id in `requirement_ids` only when the task comes from that requirement. An empty list means no link, never unknown; do not infer a link from prose. An id names a logical task, not its bytes: a deliberately reworded task keeps its id and genuinely new work gets a new id. Publish the complete spec first and then its mirrored tasks artifact in every attempt, including whenever the spec is revised.
