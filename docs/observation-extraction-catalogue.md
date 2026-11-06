# Oakridge extraction catalogue

The catalogue lives in `observation/src/producers/oakridge/catalogue.ts`, at one version. Each definition is registered with the captured artifact's `artifact_schema_version`, extractor id and extractor version `1`. A definition reads only that revision's body. A shape mismatch records `extraction_failed`; an empty matching list records `no_matching_items`.

| Artifact | Selected item | Address | Logical identity |
| --- | --- | --- | --- |
| analysis | finding | `/findings/N` | absent |
| analysis | requirement status | `/requirements/N/status` | absent |
| analysis | proposed spec update, risk | revision plus path | absent |
| tasks | task | `/tasks/N` | run-scoped task id |
| plan | cohort decision | cohort id plus local id | run and cohort-scoped id |
| plan | acceptance entry | `/cohorts/N/acceptance_criteria/M` | the entry's run-scoped task id |
| plan | risk | revision plus path | absent |
| brief | decision, rejected approach | cohort id plus local id | run and cohort-scoped id |
| brief | acceptance entry | `/acceptance_criteria/N` | the entry's run-scoped task id |
| assessment | finding | `/findings/N` | absent |

The `spec` artifact is intentionally outside this catalogue. The producer declares `spec: { schema: text }`, so its body is a bare JSON string with no addressable interior. A future text-span selector needs offset or heading rules and must state that a span is pinned to one revision and does not survive rewording.

Only explicit producer fields produce edges. An assessment finding's `task_ids` each produce an `assesses` edge to that task's logical item; a plan or brief entry is itself an occurrence of its task and needs no edge. Shared plan and brief decision ids link when the prior item exists; a brief-only id stays unlinked. Empty id lists mean no link. An explicit id pointing to a missing item remains an unresolved edge, and a task reference resolves in place if the task is captured later. The derivation creates no inferred or `split_from` edge.

When several prior revisions expose the same local id, an occurrence reference stays unresolved because capture does not retain the approval link that would identify the reviewed revision. A same-artifact reference resolves only within its own revision. This keeps replay and republication from silently retargeting an edge to whichever revision happens to sort last.

Capture retains nullable `predecessor_id` and `subject_id`. A lineage read compares a revision's digest only with its recorded predecessor in the same run and artifact kind, reporting `is_republication: true` for equal bodies and `false` for edits. Missing predecessors remain unknown. A cohort assessment's `subject_id` creates a producer-explicit `assesses` edge between revision-scoped logical anchors for that assessment and its captured build result; an absent or cross-run target remains unresolved.
