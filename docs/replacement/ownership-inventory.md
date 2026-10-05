# Replacement ownership inventory

The run supplied `epic/real-refactor` as the PR base. Its local `origin/epic/real-refactor` ref resolves to `487beef203ab42dcd30c9670bb3c803569cff257`; its merge-base with `487beef2` is the same commit. `origin/main` is an ancestor of this commit. The next migration number is `0020`: the base contains `0015_v15_baseline.sql` through `0019_v15_state_consistency.sql`.

The cohort brief refers to a separate Sec 10 list of 28 paths and six omitted modules, but that list is absent from the supplied worktree and prompt. The table below records the existing replacement candidates that can be verified at the base. It must be reconciled against the authoritative Sec 10 list before deletion.

| Old path at base | Disposition | Owner |
| --- | --- | --- |
| `oakridge-dbos/src/compiler/compile-v15.ts` | Replace definition compilation | c1 Rust core; c2 integration |
| `oakridge-dbos/src/validation/v15-definition.ts` | Replace definition validation | c1 Rust core; c2 integration |
| `oakridge-dbos/src/validation/run-inputs.ts` | Replace payload validation | c1 Rust core; c2 integration |
| `oakridge-dbos/src/validation/review-artifacts.ts` | Retain artifact review validation at IO boundary | c3 policy integration |
| `oakridge-dbos/src/decision/commands.ts` | Replace decision command model | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/derive.ts` | Replace decision selectors | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/ids.ts` | Replace workflow identifiers | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/materialize-stage.ts` | Replace stage materialization | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/schedule-cohorts.ts` | Replace scheduling decisions | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/snapshot.ts` | Replace decision snapshot model | c1 Rust core; c2 integration |
| `oakridge-dbos/src/decision/stage-machine.ts` | Replace state transition logic | c1 Rust core; c2 integration |
| `oakridge-dbos/src/domain/dev-flow-v15.ts` | Split domain types from workflow specific types | c2 |
| `oakridge-dbos/src/domain/v15-action-inputs.ts` | Replace binding contracts | c1 Rust core; c2 integration |
| `oakridge-dbos/src/domain/v15-review-actions.ts` | Replace review actions | c3 |
| `oakridge-dbos/src/domain/v15-operator-review.ts` | Replace operator review types | c3 |
| `oakridge-dbos/src/domain/worker-attention.ts` | Replace worker attention projection | c3 |
| `oakridge-dbos/src/domain/workflow.ts` | Replace workflow contracts | c2 |
| `oakridge-dbos/src/domain/workflow-recovery.ts` | Replace recovery model | c2 |
| `oakridge-dbos/src/domain/run-record.ts` | Migrate run persistence contracts | c2 |
| `oakridge-dbos/src/domain/run-event.ts` | Migrate run event contracts | c2 |
| `oakridge-dbos/src/runtime/launch-run.ts` | Use compiled program at launch | c2 |
| `oakridge-dbos/src/runtime/run-launch-dispatch.ts` | Use core decisions for dispatch | c2 |
| `oakridge-dbos/src/runtime/observe-worker-execution.ts` | Use core observations | c2 |
| `oakridge-dbos/src/runtime/implementation-worker-session.ts` | Retain session IO adapter | c3 |
| `oakridge-dbos/src/storage/materialize-stage.ts` | Use core materialization at storage boundary | c2 |
| `oakridge-dbos/src/storage/apply-stage-event.ts` | Use core effects at storage boundary | c2 |
| `oakridge-dbos/src/storage/load-run-snapshot.ts` | Build core snapshot | c2 |
| `oakridge-dbos/src/storage/postgres-run-record.ts` | Migrate run records starting at 0020 | c2 |
| `oakridge-dbos/src/storage/postgres-dev-flow.ts` | Replace v15 persistence paths | c2 |
| `oakridge-dbos/src/storage/postgres-workflow-definitions.ts` | Store generic definitions | c2 |
| `oakridge-dbos/src/http/operator-projections.ts` | Present generic operator state | c3 |
| `oakridge-dbos/src/http/run-launch.ts` | Accept compiled launch | c2 |
| `kbbl/core/pwa/oakridge/types.ts` | Declare local generic UI descriptors | c1; c3 |
| `kbbl/core/pwa/lib/workflow-defs.ts` | Use local generic workflow descriptors | c1 |

Every listed path resolves in the recorded base tree. This is a candidate inventory pending the missing Sec 10 source; it does not claim to identify its exact 28 plus six paths.
