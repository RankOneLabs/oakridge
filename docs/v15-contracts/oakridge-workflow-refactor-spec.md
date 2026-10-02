# Oakridge v15 workflow refactor specification

This specification refactors `epic/wf-interpreter` around the concrete v15 workflow and agreed [artifact schema](oakridge-workflow-schema.md). Cohorts define application work, workers, prompts, artifact outputs, and the decision tree connecting them. The stage coordinator advances stages from prerequisites and cohort completion.

Status: complete specification for the build handoff. The [full v15 contract](oakridge-v15-workflow-schema.md), [serialized workflow](oakridge-v15-workflow-definition.json), artifact schema, implementation-cohort contract, and draft prompt files specify the behavior to implement. Runtime implementation and integration verification are still required.

Implement the compiler and evaluator in TypeScript on Bun first. This is a full clean cutover: no existing-run support, legacy interpreter, dual execution path, or conversion layer is required.

The implementation inventory was reviewed at local branch commit `489268a5`. The schema and this spec are in the main workspace's `comms/` directory. The older workflow design document remains background; this spec and the accepted concrete schema govern terminology and coordinator responsibilities.

The [implementation-cohort contract](oakridge-implementation-cohort-schema.md) supplies concrete definition/runtime types, action bindings, review targets, and its [serialized definition](oakridge-implementation-cohort-definition.json). The full v15 contract completes the other five stages and their cohort-creation rules. All eighteen LLM action points have [prompt files](../../workflow-config/prompts/dev-flow/v15) ready to promote to their declared runtime paths during implementation.

## Resulting behavior

A run executes repository preparation, spec analysis, planning, brief writing, implementation, and final integration. Outputs are typed artifacts. Artifact publication, session completion, artifact acceptance, worker acceptance, and cohort completion are separate events or states.

An implementation cohort contains a builder and assessor. Both build-review feedback and assessment-based implementation feedback select the same builder revision prompt, with different input payloads. Feedback about the assessment itself returns to the assessor for discussion and possible assessment revision. The cohort completes after accepted work and the required PR merge, then the stage coordinator advances without interpreting those internal decisions.

Changing the feedback source must not require another builder action point. Changing the prompt behavior can justify another action point. Every LLM action point has an explicit prompt and declared input bindings.

## Domain ownership

| Owner | Required responsibility |
| --- | --- |
| Workflow definition | Describes stages and pins a version of their configuration. |
| Run | Stores one execution and its pinned configuration. |
| Stage | Holds its cohorts and stage prerequisites; advances using their completion. |
| Cohort | Defines its inputs, workers, application decision tree, and completion conditions. |
| Worker | Has one state enum field, action points, declared artifact outputs, and session history. |
| Action point | Declares a prompt or operation and its input bindings; identifies a behavior rather than its trigger source. |
| Session | Records one agent execution of a selected worker action point. |
| Artifact | Holds typed output content, identity, content version, provenance, and acceptance state. |

Artifact types define payload contracts and output coercion. They are associated with worker outputs. The workflow definition does not contain schema, cohort-definition, or capability registries. Cohort definitions belong to their stages. Workers do not configure lists of state names or completion states; stored workers use the state enum in the schema draft.

Repository preparation remains an operation rather than an LLM call. Its integration can reuse the existing repository provisioning adapter. No `CapabilityDefinition` abstraction is required by this refactor.

## V15 stages

| Stage | Concrete work | Completion requirement |
| --- | --- | --- |
| Repository preparation | Prepare each supplied repository and publish authoritative repository refs. | Required repository outputs exist and preparation succeeded. |
| Spec analysis | One analyzer publishes `dev.spec_analysis` from brief notes and repository context. | Analysis artifact accepted and analyzer accepted. |
| Planning | One planner publishes `dev.plan` from accepted analysis and repository refs. | Plan artifact accepted and planner accepted. |
| Brief writing | One brief writer publishes one `dev.build_brief` per planned cohort. | Complete valid brief collection accepted and brief writer accepted. |
| Implementation | Each accepted brief is implemented by a cohort containing a builder and assessor. | Every required implementation cohort completed. |
| Final integration | Each repository used by the accepted plan gets a final PR using its completed implementation outputs. | Each required final PR is confirmed merged. |

Analysis waits for repository preparation. Planning waits for accepted analysis. Brief writing waits for the accepted plan. Implementation consumes accepted briefs and authoritative repository refs. Final integration waits for all required implementation cohorts, including their PR merges.

Implementation cohorts preserve the brief's repository assignment and dependencies. A cohort cannot start before its required predecessor cohorts complete. The limit is four active implementation cohorts. Working and awaiting-merge cohorts hold capacity, including interruption and review waits; pending and terminal cohorts do not. Reserve activation slots atomically.

If any cohort fails or is cancelled, stop its stage and cancel every other unfinished cohort. Completed cohorts retain their results. Dependent stages do not start. Fence affected executions and persist session-stop intents through the cohort cancellation path; stop dispatching new work immediately. Session-stop retries remain recoverable after the stage stops.

The stage coordinator inspects stage prerequisites and cohort completion. It does not inspect assessment verdicts, artifact feedback, worker action points, or PR branches. Repository and branch checks belong to the cohort's work and its declared observations.

## Artifact contracts

Use the concrete artifact types for spec analysis, plan, brief, build result, PR summary, and assessment, plus the repository-ref, feedback, publication, and runtime types in the complete workflow contract.

Publication must identify its worker, session or operation execution, output, and artifact version. Output coercion validates the declared artifact payload. An invalid publication returns a typed failure; it does not silently drop fields, manufacture required content, or make the worker complete.

The plan's cohort IDs are unique. Repository assignments refer to supplied repositories. Dependency references exist and are acyclic. Briefs cover exactly the planned cohort keys and preserve their assignments and dependencies. Validate these constraints before starting the implementation cohorts.

Reject an empty plan. Skip final integration for supplied repositories the accepted plan does not use. Freeze cohort membership and input versions when each stage initializes. Completed upstream stages are not reopened in the same run. Materialization is atomic and idempotent; invalid mapping cannot partially activate a stage.

The accepted brief is an input artifact, not a runtime cohort record. Plan and brief artifacts do not contain sessions or worker execution state. `depends_on` is the sole scheduling authority. Remove `dependency_order` from the plan contract and planning prompt.

New artifact content clears acceptance. V15 outputs retain artifact identity and increment content version, preserving historical content and provenance so stale review cannot apply to newer content. Discussion of an assessment can preserve its content through an explicit response identifying the retained version, accepted build, execution, and explanation, returning that content to review without incrementing content version.

## Worker action points

### Spec analysis planning and brief writing

Each worker has initial, revision, and retry prompt behaviors. Reuse the existing v15 prompts where their behavior matches. Bind the accepted upstream artifacts, current output, operator feedback, and execution context explicitly.

| Worker | Initial inputs | Revision inputs | Outputs |
| --- | --- | --- | --- |
| Analyzer | Brief notes, repository context | Original inputs, current analysis, feedback | `dev.spec_analysis` |
| Planner | Accepted analysis, repository refs | Original inputs, current plan, feedback | `dev.plan` |
| Brief writer | Accepted plan, repository refs | Original inputs, current brief collection, feedback | Collection of `dev.build_brief` |

Retry receives the interrupted action's inputs and current publication context. It must not rerun completed upstream stages or erase accepted sibling work.

### Builder

| Action point | Required prompt behavior | Inputs | Outputs |
| --- | --- | --- | --- |
| Initial | Implement the accepted brief in the prepared worktree. | Brief, repository and worktree context. | Build result and PR summary. |
| Revise | Implement the supplied feedback against the existing implementation and PR. | Brief, repository and worktree context, current build outputs, feedback. | Revised build result and PR summary. |
| Retry | Recover interrupted work and finish required publication. | Interrupted action inputs, current outputs, execution context. | Build result and PR summary. |
| Replace PR | Replace the closed unmerged PR while preserving completed implementation. | Brief, repository and worktree context, current outputs, closed PR context. | Build result and replacement PR summary. |

Use the supplied builder revision prompt, consolidating build-review and assessment-revision behavior. The cohort prepares feedback from either source; the prompt implements that feedback. Required branch and repository information comes from authoritative inputs and must not be inferred from repository defaults.

### Assessor

| Action point | Required prompt behavior | Inputs | Output |
| --- | --- | --- | --- |
| Initial | Assess implementation against its brief without implementing fixes. | Brief, accepted build outputs, repository and worktree context. | Assessment. |
| Discuss | Discuss operator feedback and reconsider the current assessment. | Original assessment inputs, current assessment, feedback. | Updated or explicitly retained assessment. |
| Retry | Recover interrupted assessment work. | Interrupted action inputs, existing assessment if present, execution context. | Assessment. |

Use the supplied assessment discussion prompt. It may correct findings, justify existing findings, or change the verdict. It must not implement build fixes. Its response returns the assessment to operator review; discussion does not imply acceptance.

### Final integration

Reuse initial and retry prompt behaviors. Inputs include authoritative repository refs and completed build results, PR summaries, and assessments. The worker opens the final PR and publishes its summary. The operator confirms merge or closure without merge. The worker does not merge the PR.

## Implementation cohort decisions

The schema draft's English decision tree is the behavioral contract. The serialized tree must represent these branches directly, with conditions on stored state and leaves selecting state changes and worker action points.

| Trigger or stored condition | Required decision |
| --- | --- |
| Cohort is pending | Start initial build and mark the builder working. |
| Both current build outputs are valid and the PR is verified | Mark builder awaiting review. |
| Operator accepts the build output set | Accept both artifacts and builder; start initial assessment. |
| Operator requests build changes | Clear affected acceptance and reset assessment; invoke builder revision with build-review feedback. |
| Assessment is published | Mark assessor awaiting review. |
| Operator requests assessment discussion or revision | Invoke assessor discussion with current assessment and feedback; preserve accepted build outputs. |
| Discussion returns an updated or retained assessment | Return assessor to review. |
| Operator requests implementation changes using assessment findings | Reset build and assessment acceptance; invoke the same builder revision action with assessment findings and feedback. |
| Operator accepts assessment | Accept its artifact and assessor. |
| Builder and assessor are accepted and the verified PR is observed merged into the expected base | Complete the cohort. |
| PR closes without merge | Wait for replacement or abandonment. |
| Operator requests replacement | Invalidate old PR verification, reset affected acceptance, invoke replacement build. |
| Execution ends without required output | Mark the affected worker interrupted; offer retry or abandonment. |
| Operator retries | Invoke that worker's retry action point with its interrupted inputs. |
| Operator abandons or cancels | Stop active work and finish the cohort with the corresponding outcome. |

A review action targets exact artifact versions. Build review targets both the build result and PR summary. Assessment discussion and implementation changes are distinct operator actions with distinct routing. Their UI labels must make that distinction clear.

When build content changes, the old assessment becomes inapplicable. Resetting that work is an explicit cohort decision. When only assessment content changes, accepted build outputs remain accepted.

Assessment verdict interpretation belongs to the operator. Operator acceptance is authoritative for every verdict, including `fail`; the tree does not add a verdict-based prohibition.

## Evaluation and execution

Evaluation is pure: read the checked cohort definition and its authoritative state snapshot, evaluate its decision tree, and return selected changes and action requests. The evaluator performs no database, HTTP, Git, LLM, or session IO.

The full contract specifies the tree's exact syntax: typed state/request matches, named facts, explicit change/action leaves, waits, and rejections, with typed payload bindings. It must not delegate progression to arbitrary adapter guard functions or scripts. Waiting is a defined result. Every accepted field has execution semantics; unsupported fields are rejected.

Resolve action inputs against the snapshot that selected them. Store the selected prompt, resolved input references, action point, and execution identity with the launch intent. Revision can therefore read existing content while resetting acceptance in the same decision.

Commit selected state changes and durable action intents atomically against the owner's expected version. A conflict reloads state and reevaluates. Duplicate input or replay cannot create another session for the same committed launch. A deliberate retry or revision creates a new execution and fences the old one. Worker-specific ownership is required: the latest builder session must not invalidate an unrelated assessor session merely because both belong to one cohort.

The runtime executes committed intents and reports results. Handlers submit validated publications and operator decisions. Repository writers persist decisions. Session adapters launch and observe sessions. PR integrations publish verified observations. None of those components independently choose the next application action.

Retain recovery rechecks: notifications are wake hints, and authoritative records determine decisions. A missing or duplicate wake cannot change the chosen action. Restart recovery resumes committed work rather than reconstructing acceptance from process memory.

## Storage and cutover

Retain PostgreSQL and DBOS integrations where they satisfy these contracts. Retain current protections for optimistic concurrency, publication authorization, session fencing, durable launches, artifact provenance, and restart recovery. Verify their behavior under worker ownership before reusing them.

Define storage for the new model without preserving compatibility with old run records. Applied migrations remain immutable. Within the new model, a configuration change produces a new immutable version; runs keep their pinned definitions, prompts, and artifact interpretation.

Cut over the full workflow to the new model and remove the replaced execution paths. Existing v15 runs are unsupported; do not implement their resumption, conversion, or a fallback interpreter. The operational procedure for retiring old data belongs to deployment, not a compatibility layer in the application.

Preserve existing artifact presentation, comments, repository configuration, and session/worktree links through explicit projection mappings. Add the assessment-discussion action and its feedback route. Do not hide routing differences in generic approval labels.

## Current module responsibilities

Paths below are relative to the repository root. This is a responsibility map, not a requirement to preserve every file or its public API.

| Current area | Target responsibility and change |
| --- | --- |
| `workflow-config/definitions/dev_flow_v15.json` | Rewrite the concrete definition around stages, their cohorts, workers, typed artifact outputs, action points, and cohort trees. Do not carry obsolete fields into the new format. |
| `workflow-config/prompts/dev-flow/v15/` | Retain matching prompts; consolidate builder revision and add assessment discussion. Declare every prompt's input bindings. |
| `oakridge-dbos/src/domain/workflow.ts`, `delegated-session.ts`, `compiled-workflow.ts` | Replace stage-level role/prompt and machine contracts with the agreed concrete owner types and checked references. |
| `oakridge-dbos/src/domain/dev-flow-artifacts.ts`, `artifact-types.ts` | Keep artifact payload and presentation contracts; enforce coercion at publication. Expand the accepted schema rather than creating a workflow-level schema registry. |
| `oakridge-dbos/src/validation/` and `compiler/` | Validate concrete definitions, artifact contracts, bindings, tree branches, action points, prompt inputs, and prerequisite references. Resolve references before execution. |
| `oakridge-dbos/src/decision/stage-machine.ts` | Replace first-matching event transitions and adapter guard callbacks with the checked cohort decision tree. |
| `oakridge-dbos/src/adapters/dev-flow-machine.ts` | Retain useful PR verification and collection validation work as typed checks or observations. Remove its progression guard authority. |
| `oakridge-dbos/src/decision/stage-effects.ts` | Separate pure selected changes from IO execution. Storage must not interpret effect names and choose application progression. |
| `oakridge-dbos/src/storage/apply-stage-event.ts`, `postgres-run-record*.ts` | Preserve locking and atomic commits; persist the evaluator's decision and worker-owned execution history. Remove direct invocation of the old transition selector for new runs. |
| `oakridge-dbos/src/decision/derive.ts`, `schedule-cohorts.ts` | Keep stage prerequisites, cohort dependencies, capacity, and lifecycle aggregation. No artifact or assessment interpretation in stage advancement. |
| `oakridge-dbos/src/workflows/run-record-topology.ts`, `runtime/compose.ts` | Schedule committed executions, recover them, and report results. Remove competing application progression branches and old machine registration for new runs. |
| `oakridge-dbos/src/runtime/resolve-work-order.ts`, `prompt-template.ts`, `adapters/kbbl.ts` | Resolve declared inputs, render the selected action point's prompt, and execute through existing agent integrations. |
| `oakridge-dbos/src/runtime/cohort-pull-request.ts`, `github-pull-requests.ts` | Verify and observe PRs. Submit facts to the cohort rather than deciding worker acceptance or cohort completion. |
| `oakridge-dbos/src/http/`, `storage/postgres-operators.ts` | Validate operator/publication inputs and expose projections. Keep workflow progression in the evaluator. |
| `kbbl/core/pwa/oakridge/` | Present cohort workers, sessions, artifacts, and the distinct assessment discussion versus implementation-change actions. |

The current implementation is not discarded wholesale. Existing durability and agent integrations are candidates for retention. The decision representation, owner model, and prompt routing require substantive replacement. Assess the effort after the complete concrete configuration can be validated; do not choose a rewrite just from file counts or passing legacy tests.

## Implementation sequence

### Domain and configuration contracts

Implement named domain types and checked configuration from the complete six-stage contract. Include action point declarations, prompt input bindings, artifact coercion, cohort materialization, and tree validation. Stages own one concrete `cohort` definition; runtime stage records hold their instantiated `cohorts`. Use the specified v15 materialization transforms rather than inventing a general collection language.

Exit evidence: v15 can be read without guessing a field's meaning or inventing another worker/action route. Missing prompts, wrong artifact types, private-state reads, and invalid prerequisites fail validation. Existing types have a documented mapping to the new contract.

### Implement one cohort end to end

Implement the checked implementation cohort, evaluator, atomic commit boundary, and worker execution path. Exercise initial build, build revision, initial assessment, assessment discussion, assessment-based build revision, and merge completion.

Invariant: each application decision comes from that cohort's tree. Replace the old build-cohort transition path for those runs; do not add the tree alongside it as another progression authority.

Exit evidence: both feedback sources select the same builder revision prompt; assessment discussion runs the assessor; changed build content invalidates the old assessment; stale review and stale session publication are rejected; duplicate decisions do not launch duplicate sessions.

### Extend across v15

Use the same worker, artifact, action point, and tree constructs for analysis, planning, brief writing, and final integration. Connect repository preparation and stage advancement. Change the UI projections and review actions to the new owner model.

Invariant: stage coordination remains independent of artifact approval and assessment meaning. Replace the old prompt-matrix and gate-routing decisions for new runs.

Exit evidence: the full workflow completes with multiple repositories and dependent implementation cohorts. Brief collection validation occurs before build activation. Revising one cohort does not rerun accepted upstream stages or unrelated cohorts.

### Cut over and retire the replaced paths

Verify the new storage and projections, cut over the full workflow, and remove old progression code. No legacy execution or existing-run conversion remains. Each removal names the replacement decision authority.

Exit evidence: restart, replay, duplicate publication, concurrent operator decisions, execution interruption, cancellation, and database upgrade preserve the committed state and intended work. No silently skipped integration check counts as evidence. Service deployment and any database reset are separate operator actions.

## Acceptance scenarios

- Accept analysis and plan; revise each with feedback and confirm the correct worker prompt runs.
- Publish every planned brief, reject duplicate or unknown keys and cyclic dependencies, then accept the collection.
- Reject an empty plan; accept a nonempty plan that leaves a supplied repository unused and omit that repository's final integration cohort.
- Freeze and replay stage materialization without duplicate cohort IDs; start dependent builds only after predecessor completion and prepare their worktrees from the current run-base head.
- Publish build outputs in either order; neither a partial output set nor session exit makes the builder accepted.
- Reject a PR for the wrong repository, branch, base, or reviewed commit; report the verification failure.
- Accept the build and run assessment against the accepted artifact versions and commit.
- Request assessment discussion and receive an updated assessment or an explicit unchanged response. The builder remains accepted.
- Request implementation changes using assessment findings. The builder revision prompt receives that feedback; its revised work gets a fresh assessment.
- Verify that old artifact content, old assessment evidence, and old session results cannot satisfy the revised work.
- Observe PR merge into the expected base and complete the cohort; a closed unmerged PR stays eligible for replacement or abandonment.
- Complete all required cohorts and advance the stage without inspecting their assessment artifacts.
- Hold the four implementation slots through review and merge; do not activate a fifth cohort while those slots are occupied.
- Fail or cancel a cohort; stop its stage/run, fence and cancel unfinished work, retain completed results, and recover session-stop intents.
- Observe a final PR merge without operator confirmation and keep final integration awaiting review; confirm the exact verified PR/head and complete it.
- Repeat notifications, publication requests, and execution dispatch; observe one committed action occurrence and one intended session.
- Restart while working, reviewing, and awaiting merge; preserve current artifact versions, acceptance, prompts, and selected executions.
- Start a run on the new storage model; verify its definition remains pinned when a newer definition is introduced.
- Verify the cutover leaves no legacy interpreter, old-run fallback, or conversion path.

## Build boundaries

1. Named domain types, artifact coercion, checked configuration, and v15 materialization contracts.
2. Pure evaluator, atomic persistence, execution dispatch, fencing, and recovery.
3. Builder/assessor cohort, review, discussion, implementation revision, and merge completion.
4. Remaining v15 stages, scheduling, prompt rendering, and operator projections/actions.
5. Full clean cutover, replaced-path removal, and end-to-end verification.

The semantic choices are recorded in the full contract. Implementation should not silently introduce new workflow behavior. Resolve an actual contradiction against these contracts before changing it; routine code organization and adapter reuse do not reopen settled decisions.
