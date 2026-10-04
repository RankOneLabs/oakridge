# V15 workflow contracts

These documents and serialized definitions govern the workflow refactor. Resolve any contradiction against them before changing code. Relative prompt links point to the committed runtime prompt files.

## Cutover removal ledger

The named successor is the authority to check before each removal. This list is
the inventory for boundary 5; it does not claim that an unchecked path has been
removed.

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
silently dropped. The table is a porting record, not a test result.

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

## Verification still required before deployment

The cutover is incomplete while the old S1–S19 and S21 assertions still call
`/gates/:id/resume` and inspect retired stage-machine states. The S20 and S22
ports exercise real PostgreSQL, kbbl agent and browser boundaries; the other
cases require v15 cohort-request assertions against those same boundaries.

The repository also retains legacy declarations outside this boundary's file
scope: the generic stage-machine and adapter guard registry, the effect-name
writer contract, prompt-matrix storage and validation, and the `build_cohort`
table and projections. The stage aggregation in `decision/derive.ts` currently
chooses cancellation before failure when both occur. That order conflicts with
the required failure precedence, so the mixed-outcome acceptance case cannot
pass until that decision authority changes.

The operator must separately plan service deployment and any database reset.
No application startup path should reset production data.
