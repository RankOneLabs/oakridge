# Oakridge authority state ownership

The writer column names the mutation-service entry and the function that executes the write. Citations point to the SQL statement, so a reviewer can trace each persisted field to its commit path. `createMutationService.decide` enters `commitDecision`, which calls `writeDecision`; provider results enter the mutation service through its exported `persistEffectResult` path. Adapter-local kbbl SQLite state is outside this authority inventory.

| State | Function-level writer and SQL citation | Authority and derived copies |
| --- | --- | --- |
| Schema baseline | `migrateEmptyDatabase` → `migrate`, `oakridge-dbos/src/storage/migrate.ts:24` | Migration bookkeeping only. |
| Pinned definition and checked program | `createMutationService.pinDefinition`, `oakridge-dbos/src/storage/mutation-service.ts:102`; `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:148` | The source bundle and compiled program are pinned together by digest. |
| Pinned prompt content | `storePromptContents`, `oakridge-dbos/src/storage/prompt-content.ts:80`, called by `createMutationService.pinDefinition` and `createMutationService.startRun` | Content-addressed by SHA-256 and immutable; a pinned definition names its prompts by digest and every render reads this copy, never the authored file. |
| Run identity and bundle link | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:151`; `deleteRun`, `oakridge-dbos/src/storage/run-lifecycle.ts:76` | One run refers to one pinned definition. |
| Current run workflow generation and scope cursor | `claimRunGeneration`, `oakridge-dbos/src/storage/run-lifecycle.ts:93` | The run workflow's address and pending scan position survive rollover and restart. |
| Root scope and initial state | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:152` | Initial state comes from the checked root definition. |
| Child scope and input | `createMutationService.decide` → `commitDecision` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:115` and `oakridge-dbos/src/storage/commit.ts:124` | Child instances are created from declared child mutations. |
| Scope state, outcome, terminal flag, version | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:104`, `oakridge-dbos/src/storage/commit.ts:138`, `oakridge-dbos/src/storage/commit.ts:161`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:74` | Scope outcome is the durable terminal projection of a decision; version also advances for a terminal execution result. |
| Launch receipt | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:162` | Idempotent run creation. |
| Scope export | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:105` | Child consumers read the committed export. |
| Child collection membership | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:126` | Membership is explicit; child scope rows carry the corresponding collection key. |
| Execution selection and generation | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:108` and `oakridge-dbos/src/storage/commit.ts:136`; `cancelRun`, `oakridge-dbos/src/storage/run-lifecycle.ts:49` | Current worker selection points at an execution; generation fences predecessors. |
| Execution identity, result, status, publication secret hash | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:135` and `oakridge-dbos/src/storage/commit.ts:154`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:73` | `execution.result` duplicates the terminal checked value stored in an invocation-keyed fact. |
| Artifact revision body and predecessor | `createMutationService.decide` → `writeOutputs`, `oakridge-dbos/src/storage/commit.ts:85` | Immutable publication history. |
| Current output revision | `createMutationService.decide` → `writeOutputs`, `oakridge-dbos/src/storage/commit.ts:86` and `oakridge-dbos/src/storage/commit.ts:87`; `writeDecision`, `oakridge-dbos/src/storage/commit.ts:103` | Pointer into artifact history, cleared by a decision mutation. |
| Trigger and terminal-result facts | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:158`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:70` | Trigger facts feed decisions; invocation-keyed terminal facts mirror `execution.result`. |
| Transition decision | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:160` | Decision record; its terminal outcome also appears on `scope_instance`. |
| Ingress receipt | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:164` | Idempotent command/publication response. |
| Effect intent, handle, status, evidence | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:156`; `claimStartAttempt`, `oakridge-dbos/src/storage/effect-results.ts:23`; `persistEffectResult`, `oakridge-dbos/src/storage/effect-results.ts:52` and `oakridge-dbos/src/storage/effect-results.ts:64` (learned handle copied to a stop recorded mid-start); `ensureStopIntent`, `oakridge-dbos/src/storage/revocation.ts:9` | The intent is the durable provider obligation. Its settled status and the execution terminal status are separate projections. |
| Capacity pool and reservation | `createMutationService.startRun`, `oakridge-dbos/src/storage/mutation-service.ts:159`; `createMutationService.decide` → `applyCapacityChanges`, `oakridge-dbos/src/storage/capacity.ts:14`, `oakridge-dbos/src/storage/capacity.ts:15` and `oakridge-dbos/src/storage/capacity.ts:16` | Pool limit is run-local; active reservations determine available capacity. |
| Effect revocation status and version | `revokeStarts`, `oakridge-dbos/src/storage/revocation.ts:30` | Used by decision revocation and run cancellation; stop intent creation belongs to `ensureStopIntent`. |
| Evidence delivery acknowledgement and intent version | `deliverEvidence`, `oakridge-dbos/src/effects/evidence.ts:24` | Receipt-backed delivery marks the evidence as delivered; this IO ledger writer is separate from effect settlement. |
| Resource binding | `createMutationService.decide` → `writeDecision`, `oakridge-dbos/src/storage/commit.ts:101` and `oakridge-dbos/src/storage/commit.ts:102` | Observation is updated or cleared by a decision mutation. |

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
- `createMutationService.pinDefinition` `oakridge-dbos/src/storage/mutation-service.ts:98`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:146`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:149`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:150`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:157`
- `createMutationService.startRun` `oakridge-dbos/src/storage/mutation-service.ts:160`
- `claimStartAttempt` `oakridge-dbos/src/storage/effect-results.ts:24`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:52`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:64`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:70`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:73`
- `persistEffectResult` `oakridge-dbos/src/storage/effect-results.ts:74`
- `storePromptContents` `oakridge-dbos/src/storage/prompt-content.ts:80`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:87`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:88`
- `writeOutputs` `oakridge-dbos/src/storage/commit.ts:89`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:103`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:104`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:105`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:106`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:107`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:110`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:117`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:126`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:128`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:137`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:138`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:140`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:158`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:160`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:162`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:164`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:165`
- `writeDecision` `oakridge-dbos/src/storage/commit.ts:168`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:14`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:15`
- `applyCapacityChanges` `oakridge-dbos/src/storage/capacity.ts:16`
- `deliverEvidence` `oakridge-dbos/src/effects/evidence.ts:24`
