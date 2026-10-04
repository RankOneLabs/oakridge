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
