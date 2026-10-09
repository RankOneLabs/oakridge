# Oakridge authority state ownership

The writer column names the mutation-service entry and the function that executes the write. Citations point to the SQL statement, so a reviewer can trace each persisted field to its commit path. `createMutationService.decide` enters `commitDecision`, which calls `writeDecision`; provider results enter the mutation service through its exported `persistEffectResult` path. Adapter-local kbbl SQLite state is outside this authority inventory.

| State | Function-level writer and SQL citation | Authority and derived copies |
| --- | --- | --- |
| Schema baseline | `migrateEmptyDatabase` → `migrate`, `oakridge-dbos/src/storage/migrate.ts:24` | Migration bookkeeping only. |
| Pinned definition and checked program | `createMutationService.pinDefinition`, `oakridge-dbos/src/storage/mutation-service.ts:119`; `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:167` | The source bundle and compiled program are pinned together by digest. |
| Pinned prompt content | `storePromptContents`, `oakridge-dbos/src/storage/prompt-content.ts:80`, called by `createMutationService.pinDefinition` and `createMutationService.startRun` | Content-addressed by SHA-256 and immutable; a pinned definition names its prompts by digest and every render reads this copy, never the authored file. |
| Run identity and bundle link | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:170`; `deleteRun`, `oakridge-dbos/src/storage/run-lifecycle.ts:76` | One run refers to one pinned definition. |
| Current run workflow generation and scope cursor | `claimRunGeneration`, `oakridge-dbos/src/storage/run-lifecycle.ts:93` | The run workflow's address and pending scan position survive rollover and restart. |
| Root scope and initial state | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:171` | Initial state comes from the checked root definition. |
| Child scope and input | `createMutationService.decide` → `commitDecision` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:126` and `oakridge-dbos/src/storage/commit.ts:135` | Child instances are created from declared child mutations. |
| Scope state, outcome, terminal flag, version | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:115`, `oakridge-dbos/src/storage/commit.ts:149`, `oakridge-dbos/src/storage/commit.ts:174`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:104` | Scope outcome is the durable terminal projection of a decision; version also advances for a terminal execution result. |
| Launch receipt | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:181` | Idempotent run creation. |
| Scope export | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:116` | Child consumers read the committed export. |
| Child collection membership | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:137` | Membership is explicit; child scope rows carry the corresponding collection key. |
| Execution selection and generation | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:119` and `oakridge-dbos/src/storage/commit.ts:147`; `cancelRun`, `oakridge-dbos/src/storage/run-lifecycle.ts:49` | Current worker selection points at an execution; generation fences predecessors. |
| Execution identity, result, status, publication secret hash | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:146` and `oakridge-dbos/src/storage/commit.ts:167`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:103` | `execution.result` duplicates the terminal checked value stored in an invocation-keyed fact. |
| Artifact revision body and predecessor | `createMutationService.decide` → `writeOutputs`, `oakridge-dbos/src/storage/commit.ts:96` | Immutable publication history. |
| Current output revision | `createMutationService.decide` → `writeOutputs`, `oakridge-dbos/src/storage/commit.ts:97` and `oakridge-dbos/src/storage/commit.ts:98`; `writeDecision`, `oakridge-dbos/src/storage/commit.ts:114` | Pointer into artifact history, cleared by a decision mutation. |
| Trigger and terminal-result facts | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:171`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:100` | Trigger facts feed decisions; invocation-keyed terminal facts mirror `execution.result`. |
| Transition decision | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:173` | Decision record; its terminal outcome also appears on `scope_instance`. |
| Ingress receipt | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:177`; `createMutationService.decide` → `commitDecision` → `writeRejection`, `oakridge-dbos/src/storage/commit.ts:184` | Idempotent command/publication response; a rejected decision writes only this row. |
| Effect intent, handle, status, evidence | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:169`; `claimStartAttempt`, `oakridge-dbos/src/storage/effect-results.ts:24`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:82` and `oakridge-dbos/src/storage/effect-results.ts:94` (learned handle copied to a stop recorded mid-start); `ensureStopIntent`, `oakridge-dbos/src/storage/revocation.ts:10` | The intent is the durable provider obligation. Its settled status and the execution terminal status are separate projections. |
| Effect intent dispatch generation, redispatch failure count, deadline | `claimDispatchGeneration`, `oakridge-dbos/src/storage/effect-results.ts:42`; `claimChildRedispatch`, `oakridge-dbos/src/storage/effect-results.ts:51`; `stampEffectDeadline`, `oakridge-dbos/src/storage/effect-results.ts:63` | Addresses the live carrier for a redispatch and bounds it; the deadline is stamped once, absolute, and never refreshed on carry-over or redispatch. |
| Capacity pool and reservation | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:178`; `createMutationService.decide` → `applyCapacityChanges`, `oakridge-dbos/src/storage/capacity.ts:14`, `oakridge-dbos/src/storage/capacity.ts:15` and `oakridge-dbos/src/storage/capacity.ts:16` | Pool limit is run-local; active reservations determine available capacity. |
| Effect revocation status and version | `revokeStarts`, `oakridge-dbos/src/storage/revocation.ts:32` | Used by decision revocation and run cancellation; stop intent creation belongs to `ensureStopIntent`. |
| Evidence delivery acknowledgement and intent version | `deliverEvidence`, `oakridge-dbos/src/effects/evidence.ts:24` | Receipt-backed delivery marks the evidence as delivered; this IO ledger writer is separate from effect settlement. |
| Resource binding | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:112` and `oakridge-dbos/src/storage/commit.ts:113` | Observation is updated or cleared by a decision mutation. |

`deleteRun` removes run-owned rows after cleanup obligations are discharged (`oakridge-dbos/src/storage/run-lifecycle.ts:73`, `oakridge-dbos/src/storage/run-lifecycle.ts:74`, `oakridge-dbos/src/storage/run-lifecycle.ts:75`, `oakridge-dbos/src/storage/run-lifecycle.ts:76`). The explicit duplicate values above are the input to the later state-ownership re-scope; this inventory does not change which copy is authoritative.

The ownership check enumerates every authority SQL write site in the active backend dependency graph and requires a citation naming its enclosing function. New write sites, including IO ledger writes and deletions, must be documented; citation formatting alone does not establish completeness.

## Current SQL write-site citations

These citations keep the authority inventory aligned with the startup, encryption, and recovery paths.

- `migrateEmptyDatabase` `oakridge-dbos/src/storage/migrate.ts:24`
- `cancelRun` `oakridge-dbos/src/storage/run-lifecycle.ts:49`
- `deleteRun` `oakridge-dbos/src/storage/run-lifecycle.ts:73`
- `deleteRun` `oakridge-dbos/src/storage/run-lifecycle.ts:74`
- `deleteRun` `oakridge-dbos/src/storage/run-lifecycle.ts:75`
- `deleteRun` `oakridge-dbos/src/storage/run-lifecycle.ts:76`
- `claimRunGeneration` `oakridge-dbos/src/storage/run-lifecycle.ts:93`
- `ensureStopIntent` `oakridge-dbos/src/storage/revocation.ts:10`
- `revokeStarts` `oakridge-dbos/src/storage/revocation.ts:32`
- `createMutationService.pinDefinition` `oakridge-dbos/src/storage/mutation-service.ts:119`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:167`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:170`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:171`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:178`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:181`
- `claimStartAttempt` `oakridge-dbos/src/storage/effect-results.ts:24`
- `claimDispatchGeneration` `oakridge-dbos/src/storage/effect-results.ts:42`
- `claimChildRedispatch` `oakridge-dbos/src/storage/effect-results.ts:51`
- `stampEffectDeadline` `oakridge-dbos/src/storage/effect-results.ts:63`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:82`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:94`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:100`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:103`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:104`
- `storePromptContents` `oakridge-dbos/src/storage/prompt-content.ts:80`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:96`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:97`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:98`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:112`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:113`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:114`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:115`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:116`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:119`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:126`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:135`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:137`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:146`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:147`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:149`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:167`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:169`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:171`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:173`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:174`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:177`
- `writeRejection` `oakridge-dbos/src/storage/commit.ts:184`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:14`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:15`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:16`
- `deliverEvidence` `oakridge-dbos/src/effects/evidence.ts:24`
