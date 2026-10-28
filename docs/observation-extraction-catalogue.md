# Initial Oakridge extraction catalogue

The catalogue follows the selected items in [Spec 01](scoreable-artifact-inventory.md) and the producer links in [Spec 02](spec-02-handoff.md). Each definition is registered with the captured artifact's `artifact_schema_version`, extractor id and extractor version `1`. A definition reads only that revision's body. A shape mismatch records `extraction_failed`; an empty matching list records `no_matching_items`.

| Artifact | Selected item | Address | Logical identity |
| --- | --- | --- | --- |
| analysis | finding | finding id | run-scoped finding id |
| analysis | requirement status | `/requirements/N/status` | absent |
| analysis | proposed spec update, risk | revision plus path | absent |
| tasks | task | task id | run-scoped task id |
| plan | cohort decision, criterion | cohort id plus local id | run and cohort-scoped id |
| plan | plan-wide criterion, risk | revision plus path | absent |
| brief | decision, rejected approach, criterion | cohort id plus local id | run and cohort-scoped id |
| assessment | finding | `/findings/N` | absent |

The `spec` artifact is intentionally outside this catalogue. The producer declares `spec: { schema: text }`, so its body is a bare JSON string with no addressable interior. A future text-span selector needs offset or heading rules and must state that a span is pinned to one revision and does not survive rewording.

Only the producer fields named in Spec 02 produce edges. Shared plan and brief ids link when the prior item exists; a brief-only id stays unlinked. Empty id lists mean no link. An explicit id pointing to a missing item remains an unresolved edge. The derivation creates no inferred or `split_from` edge; `split_from` is restricted to human assertions.

When several prior revisions expose the same local id, L1 leaves the reference unresolved because the L0 mirror does not retain the approval link that would identify the reviewed revision. A same-artifact reference resolves only within its own revision. This keeps replay and republication from silently retargeting an edge to whichever revision happens to sort last.

The current L0 mirror does not retain `predecessor_id` or `subject_id`. As a result, L1 cannot identify a republication pair or derive the assessment-to-build-result subject edge from captured data. The lineage response reports republication as unknown until those L0 fields are available; it does not infer either relation from timestamps or prose.
