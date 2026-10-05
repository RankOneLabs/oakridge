# Replacement relation ownership

The replacement namespace is `oakridge_replacement`. Scope position is the latest `transition` by version. A newly created scope needs a genesis transition; `scope_instance` contains only immutable identity and inputs plus its immutable terminal outcome.

| Relation | Sole authoritative fact |
| --- | --- |
| `definition_bundle` | Checked definition and pinned content |
| `run` | Definition pin, root reference, and lifecycle timestamps |
| `scope_instance` | Parent/template identity, immutable input, terminal outcome |
| `scope_export` | Current explicitly exported value and its owner version |
| `child_collection` | Frozen child membership/dependencies and conflict version |
| `execution_selection` | Current execution and generation for a worker |
| `execution` | Frozen invocation, operation/provider identity, observed execution evidence |
| `artifact_revision` | Immutable body, lineage, bundle pin, provenance |
| `output_slot` | Current revision reference for one output |
| `fact` | Immutable accepted trigger or external observation |
| `transition` | Scope position/version, decision audit, read set, and changes |
| `ingress_receipt` | Request identity/digest, pending decision and committed response |
| `effect_intent` | Effect payload, delivery progress, retry and acknowledgement |
| `capacity_pool` | Configured limit and conflict version |
| `capacity_reservation` | Current reservation owner |
| `resource_binding` | Durable external identity and observed evidence |

A transition may reference a fact, but does not copy the fact payload. The receipt records the response to a request; the transition records the resulting scope position. Neither artifact revisions nor output slots carry approval.
