# Replacement ownership inventory

Authoritative source: [governing specification](governing-specification.md), recovered verbatim from assessment run `40cdf616-b7a6-4ad0-897d-454fc83559a6`, `oakridge.workflow_run.context.brief_notes`. Baseline: `487beef203ab42dcd30c9670bb3c803569cff257`. The source calls this `epic/schema-refact`; the cohort supplied `epic/real-refactor` at the same commit. Content identity is the baseline here.

Section 10 names 30 concrete backend paths plus responsibility families and adjacent packages. It does **not** prescribe an exact 28-path list. The cohort brief's “28 + six” count is not an authoritative completeness criterion. Every concrete path below was verified with `git cat-file -e <baseline>:<path>`. Section 5, rather than Section 4, contains the compiler rejection checklist.

This inventory assigns work; it does not claim that c1 has performed the c2–c4 production cutover. The next existing migration is `0020`. The current application still runs v15 until those cohorts replace composition and persistence.

| Concrete path at baseline | Source disposition | Owner |
| --- | --- | --- |
| `oakridge-dbos/src/compiler/compile-v15.ts` | Delete; Rust compiles the generic language | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/validation/v15-definition.ts` | Delete; Rust compiles the generic language | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/stage-machine.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/derive.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/materialize-stage.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/snapshot.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/commands.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/decision/schedule-cohorts.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts | c1: replacement core; c2: remove old caller |
| `oakridge-dbos/src/domain/dev-flow-v15.ts` | Delete engine-domain use; behavior moves to configuration and payload schemas | c2: authority/cutover |
| `oakridge-dbos/src/domain/v15-action-inputs.ts` | Delete engine-domain use; behavior moves to configuration and payload schemas | c2: authority/cutover |
| `oakridge-dbos/src/domain/v15-operator-review.ts` | Delete engine-domain use; behavior moves to configuration and payload schemas | c2: authority/cutover |
| `oakridge-dbos/src/domain/v15-review-actions.ts` | Delete engine-domain use; behavior moves to configuration and payload schemas | c2: authority/cutover |
| `oakridge-dbos/src/storage/load-stage-cohort.ts` | Delete; new scope snapshot reader and single commit boundary | c2: authority/cutover |
| `oakridge-dbos/src/storage/materialize-stage.ts` | Delete; new scope snapshot reader and single commit boundary | c2: authority/cutover |
| `oakridge-dbos/src/storage/apply-stage-event.ts` | Delete; new scope snapshot reader and single commit boundary | c2: authority/cutover |
| `oakridge-dbos/src/storage/postgres-run-record.ts` | Replace entirely against the new authority model; do not keep a generic writer plus a selected-cohort writer | c2: authority/cutover |
| `oakridge-dbos/src/storage/postgres-run-record-repository.ts` | Replace entirely against the new authority model; do not keep a generic writer plus a selected-cohort writer | c2: authority/cutover |
| `oakridge-dbos/src/storage/postgres-dev-flow.ts` | Rewrite resource/publication/projection responsibilities; delete workflow progression and duplicated facts | c2: authority/cutover |
| `oakridge-dbos/src/storage/postgres-operators.ts` | Rewrite resource/publication/projection responsibilities; delete workflow progression and duplicated facts | c2: authority/cutover |
| `oakridge-dbos/src/storage/postgres-domain.ts` | Rewrite resource/publication/projection responsibilities; delete workflow progression and duplicated facts | c2: authority/cutover |
| `oakridge-dbos/src/runtime/run-launch-dispatch.ts` | Replace with generic root creation, scope evaluation and effect delivery; remove both old evaluator paths and v2 operation names | c2: authority/cutover |
| `oakridge-dbos/src/runtime/launch-run.ts` | Replace with generic root creation, scope evaluation and effect delivery; remove both old evaluator paths and v2 operation names | c2: authority/cutover |
| `oakridge-dbos/src/runtime/cancel-v2-run.ts` | Replace with generic root creation, scope evaluation and effect delivery; remove both old evaluator paths and v2 operation names | c2: authority/cutover |
| `oakridge-dbos/src/workflows/run-record-topology.ts` | Replace with generic root creation, scope evaluation and effect delivery; remove both old evaluator paths and v2 operation names | c2: authority/cutover |
| `oakridge-dbos/src/runtime/implementation-worker-session.ts` | Delete orchestration modules; extract only tested low-level operations into providers without scope/worker branching | c3: providers/effect delivery |
| `oakridge-dbos/src/runtime/implementation-publication.ts` | Delete orchestration modules; extract only tested low-level operations into providers without scope/worker branching | c3: providers/effect delivery |
| `oakridge-dbos/src/runtime/prepare-cohort-repository.ts` | Delete orchestration modules; extract only tested low-level operations into providers without scope/worker branching | c3: providers/effect delivery |
| `oakridge-dbos/src/runtime/final-integration.ts` | Delete orchestration modules; extract only tested low-level operations into providers without scope/worker branching | c3: providers/effect delivery |
| `oakridge-dbos/src/adapters/dev-flow.ts` | Remove progression knowledge; providers expose typed operations/results | c3: providers/effect delivery |
| `oakridge-dbos/src/runtime/compose.ts` | Rewrite composition around Rust client, mutation service, durable effects, and read-only projections; remove shared unbounded single-flight polls | c2: authority/cutover |

Section 10 also requires these families; the concrete rows alone are not the complete deletion surface:

| Responsibility family | Required disposition | Owner |
| --- | --- | --- |
| Workflow-specific attention/cohort types and fixed workflow repository contracts | Remove engine-domain use and closed persistence vocabulary | c2/c3 |
| Workflow-specific branches in operators/domain/definition repositories | Rewrite publication, resources and projections against the new authority | c2/c3 |
| Workflow-aware executor composition and hardcoded HTTP review/artifact registries | Replace progression with typed provider operations and checked commands | c3 |
| PWA worker review/retry mappings, definition validation, lifecycle hooks | Use generic descriptors, seen versions, receipts; c1 isolates existing HTTP DTOs and removes backend imports | c4 |
| v15 definitions and prompt copies | One canonical generic example bundle; delete unreferenced duplicates | c4 |
| Old architecture allowlists and implementation-bound tests | Ownership/import checks and semantic/recovery behavior tests | all cohorts |
| kbbl ACP ledger and obsolete workflow tables/readers/routes | Keep standalone sessions; remove competing workflow authority, reject unsupported ingress explicitly | c2/c3 |
| Dashboard launch/cancel/delete/liveness and historical archives | Use acknowledged core projections/cleanup; label read-only unmanaged history | c4 |
| Python fixed coordinator for managed workflows | Retain bounded operations; migrate iteration/termination into generic scopes | c4/consolidation |

The original analysis additionally omitted these integration points. They resolve at the same baseline and must be included when checking the cutover:

| Adjacent path | Required disposition | Owner |
| --- | --- | --- |
| `oakridge-dbos/src/storage/migrate.ts` | New namespace migration and authority constraints | c2 |
| `kbbl/core/acp/legacy-wire.ts` | Remove acceptance-and-discard compatibility; typed durable ingress or explicit unsupported | c3 |
| `oakridge-dbos/src/validation/validate-definition-files.ts` | Validate bundled generic definitions using Rust | c1 tooling/c2 cutover |
| `oakridge-dbos/src/seed/dev-flow-v15.ts` | Convert development example into generic configuration | c4 |
| `oakridge-dbos/src/seed/seed-builtins.ts` | Seed one canonical pinned bundle | c4 |
| `oakridge-dbos/src/main.ts` | Compose only new authority/effects/client at cutover | c2/c3 |
