# V15 workflow contracts

These documents and serialized definitions govern the workflow refactor. Resolve any contradiction against them before changing code. Relative prompt links point to the committed runtime prompt files.

## Cutover removal ledger

The replaced runtime paths below have been removed. Historical numbered
migrations remain immutable; migration `0018_v15_clean_cutover.sql` removes
the duplicate adapter cohort table and replaces prompt matrix storage with
compiled action-point entries. The source-wide architecture check prevents
reintroducing the retired interpreters.

| Replaced path | Successor decision authority |
| --- | --- |
| `dev_flow.build_cohort` progression and its stage machine declarations | `oakridge.cohort`, `cohort_worker`, and the checked `evaluateV15Cohort` tree |
| `domain/stage-machine.ts` event rows, guards and effect references | checked v15 cohort tree and typed selected changes in `decision/stage-machine.ts` |
| `adapters/dev-flow.ts` adapter event guard registration | typed PR observations supplied to the v15 evaluator |
| effect-name interpretation in the run-record writer and registry | selected `V15Change` committed by `commitSelectedCohort` |
| role by `launch_reason` prompt matrix | pinned action-point prompt bindings in the compiled v15 definition |
| gate-specific routing decisions | typed v15 operator requests evaluated against the current cohort context |
| legacy machine registration and competing cohort progression in `runtime/compose.ts` and `workflows/run-record-topology.ts` | one run coordinator, one stage coordinator, and worker execution intents from committed v15 decisions |
| old-run resumption, fallback or conversion | clean v15 storage cutover; no runtime successor |

Deployment and any database reset are separate operator actions. Existing runs
from the replaced storage model cannot be resumed; the operator must retire
them during deployment before starting the new service.

## S1–S22 acceptance disposition

The old suite used stage-machine states and artifact gates as its assertions.
Each case below maps to the v15 behavior to prove. “Retired” means the old
operation has no equivalent; its replacement is stated so the behavior is not
silently dropped. The table maps every original case to its executable v15 replacement.

| Case | Disposition and reason |
| --- | --- |
| S1 | Replaced: six-stage run and dependency-ordered implementation cohorts supersede the gate-driven straight-through run. |
| S2 | Replaced: publication verifies repository, PR number, branch, base and head against frozen cohort authority; replacement PR uses a typed request. All original mismatch variants map here. |
| S3 | Replaced: unreadable forge observations remain unavailable and cannot authorize publication. |
| S4 | Replaced: `request_build_changes` pins build-review feedback and launches the builder revision action. |
| S5 | Replaced: `request_implementation_changes` pins assessment feedback and launches the same builder revision action with fresh assessment. |
| S6 | Replaced: an interrupted build worker is retried through a versioned operator request and a stable execution identity. |
| S7 | Replaced: an interrupted assessment worker is retried without changing the accepted build. |
| S8 | Replaced: forge polling supplies an observation; the implementation tree completes only after a merge at the accepted head. |
| S9 | Retired: the old build-gate “Confirm merged” action is gone. Final integration alone requires operator confirmation of the exact observed PR and head. |
| S10 | Replaced: a closed unmerged PR remains in `awaiting_merge` until a merge, replacement or abandonment is selected. |
| S11 | Replaced: a merged PR at a different head cannot satisfy the accepted build's merge predicate. |
| S12 | Replaced: run cancellation fences selected execution intents and closes unfinished cohorts while retaining completed results. |
| S13 | Replaced: roster opening and cancellation serialize through durable owner state, so a cancelled cohort cannot start work. |
| S14 | Replaced: restart reattaches to the selected execution and preserves worker output and acceptance versions. |
| S15 | Replaced: publication after the worker enters review is refused without a new artifact revision. |
| S16 | Retired: deciding the same generic gate twice is no longer an operation. The versioned cohort request deduplicates by request identity and rejects a stale version. |
| S17 | Replaced: abandoning a live implementation cohort fails its stage and run and fences unfinished siblings. |
| S18 | Replaced: cyclic brief dependencies fail collection validation before implementation materialization. |
| S19 | Replaced: an unknown brief dependency fails collection validation before implementation materialization. |
| S20 | Replaced: missing publication authority interrupts the selected worker; v15 keeps its cohort available for an explicit retry. |
| S21 | Replaced: a gated artifact cannot be edited into a versioned worker output; review requests target the exact published version. |
| S22 | Replaced: the browser launches a v15 run and submits an `accept_analysis` cohort request from the review inbox. |

## Executable acceptance coverage

`bun run test:acceptance` in `oakridge-dbos` builds the kbbl PWA and runs every
suite below. Agent scenarios use scripted ACP agents behind a real kbbl
process, real Git repositories and PostgreSQL; forge responses are fixture
HTTP observations. Browser cases use Chromium against the built operator UI.

| Cases | Executable boundary |
| --- | --- |
| S1, S8, S9, S14, S18, S19 | `v15-full-run-shadow.test.ts`: all six stages, dependency ordering, exact final confirmation, invalid plan graphs and brief dependencies, three backend process crashes/restarts, and definition/prompt pinning after a newer definition is inserted. |
| S2, S3, S4, S5, S8, S10, S11, S12, S15, S16, S17 | `dev-flow-e2e.test.ts`: production publication/request HTTP boundaries, forged identity variants, forge outages/recovery, revisions, merge predicates, fencing, request replay/stale-version rejection, and failure-before-cancellation propagation retaining completed results. |
| S2, S5, S6, S7, S10, S12 | `implementation-boundaries.test.ts`: real kbbl worker retries, both builder revision routes, changed and unchanged assessment discussion, PR replacement, atomic publication/fencing and preparation recovery. |
| S13, S16 | `v15-stage-runtime.test.ts`: concurrent roster opening/cancellation, cancellation before stage initialization, frozen membership replay, and session-free provisioning recovery. |
| S6, S7, S12, S16 | `apply-stage-event.test.ts`: selected execution/session replay, recoverable stop intent, interruptions/retries and cancellation during unavailable IO. |
| S15, S16 | `v15-cohort-storage.test.ts`: lost publication response replay, conflicting identity reuse, and concurrent competing publications. |
| S20, S21, S22 | `dev-flow-browser.test.ts`: missing pinned publication prompt, refused artifact overwrite, browser run launch and exact `accept_analysis` request. |

`bun run test:unit` additionally checks the entire strict definition/compiler,
all authored evaluator leaves, readiness and materialization, owner-local
contention, and architecture/migration invariants. `bun run typecheck` and
`bun run validate:definitions` check types and the committed six-stage,
eighteen-prompt definition.

Failure is evaluated before cancellation. The coordinator durably fences
unfinished siblings before recording their stage/run's terminal outcome;
completed artifacts and acceptance records remain intact. Repository identity
comes from frozen cohort inputs; only the current/pending repository head and
verified PR binding are mutable cohort fields.

## Deployment handoff

Stop every old backend and DBOS worker, archive run evidence needed outside
the service, create a fresh application database, apply all numbered migrations
and start the backend to seed v15 definitions. Use a new application version.
There is no old-run adoption, fallback or conversion path. Migration `0018`
refuses nonempty run or prompt ledgers and startup validates the final schema; application
startup never resets data. Existing completed v15 migrations can restart in
place and keep their frozen definitions and selected executions.

Deployment, database reset, assessment approval and merging remain operator
actions. The verification command is reproducible evidence, not a merge decision.
