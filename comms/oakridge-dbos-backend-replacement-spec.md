# Oakridge v2 DBOS backend replacement specification

**Status:** Proposed; architecture plan in review
**Date:** 2026-08-14
**Decision basis:** `comms/dbos-spike-findings.md`
**Target:** Replace the custom Rust orchestration substrate with DBOS Transact
for TypeScript while preserving Oakridge's workflow-definition, artifact,
review, operator-API, and kbbl delegated-session contracts.

## 1. Outcome

Oakridge v2 becomes a TypeScript domain service hosted on DBOS. This is not a
port of kbbl v1 and it is not a TypeScript rewrite of the Rust coordinator.
The existing Rust v2 workflow definition and domain contracts remain the
authoritative starting point. DBOS replaces the custom orchestration substrate.

The governing dependency direction is:

```text
Oakridge workflow definition and stage contracts
  -> DBOS durable workflow operations
    -> executor adapter selected by the stage type
      -> optional external execution resource, such as a kbbl session
    -> Oakridge artifacts and policy evaluation
  -> stage and workflow outcomes
```

Workflow execution never originates from, or is reconstructed from, sessions.
A stage executor may use one session, many sessions, a headless agent, or no
agent process. Session existence and terminal state are not stage success
criteria.

DBOS owns the
durable execution mechanics:

- workflow scheduling and recovery;
- runtime-cardinality child creation;
- fan-out concurrency and fan-in;
- durable waits and messages;
- step checkpointing and retry;
- workflow history, status, lineage, versioning, and forks.

Oakridge continues to own:

- the existing `WorkflowDef` JSON authoring contract;
- definition validation and binding resolution;
- stage and artifact type definitions;
- artifacts and revision chains;
- review items, comments, decisions, and policy;
- Epic/repository/PR domain state and reconciliation;
- prompt rendering and executor adapters;
- kbbl session, worktree, and transcript integration;
- the HTTP/read-model surface consumed by the existing kbbl UI.

The replacement must not introduce an Oakridge scheduler, recovery loop,
fan-out execution ledger, or inferred cardinality. The existing Rust backend is
retired only after the compatibility and recovery acceptance tests in this spec
pass.

### 1.1 Non-negotiable ownership boundary

Oakridge answers domain questions:

- What stages, inputs, outputs, and edges does this definition declare?
- What runtime materialization does a stage contract request?
- Which artifacts satisfy an output contract?
- Which review, merge, handoff, or other policy condition releases an output?
- What does success, failure, revision, or cancellation mean for the stage?

DBOS answers operational questions:

- Which durable operation runs next?
- Which child operations exist for a runtime materialization?
- Which operations may run concurrently or must wait for dependencies?
- What is retried or replayed after failure?
- Which durable message or event wakes a waiting workflow?
- What history and fork lineage produced this attempt?

Executor adapters answer execution-mechanism questions. The kbbl adapter owns
session creation, attachment, worktrees, processes, transcripts, and runtime
controls. Those concepts do not appear in the workflow coordinator's control
logic.

## 2. Compatibility boundary

### 2.1 Workflow definitions remain unchanged

The input contract is the existing immutable definition shape:

```text
WorkflowDef
  graph: WorkflowGraph
    stages: Map<StageKey, StageNodeDef>
      stage_type
      operator_role?
      config
      inputs: InputSlot[]
      outputs: OutputSlot[]
    edges: Edge[]
```

The initial implementation must load and run
`oakridge-core/examples/dev_flow_v11.json` without rewriting its stage configs.
The following semantics remain stable:

- `SlotBinding` variants and RFC-6901 path behavior;
- `delivery: producer_complete | unit_complete`;
- `collect` and optional input slots;
- `delegated_session` configuration, including `runtime`, `model`, `effort`,
  prompt templates, workdir, worktree, `fan_out`, `artifacts`,
  `output_gate`, `output_handoff`, and manual admission;
- the implicit non-fan-out unit ID `"0"`;
- current typed dev-flow artifact bodies and descriptor metadata.

Compatibility means the same JSON has the same domain meaning. It does not mean
preserving the Rust implementation's internal lowering. In particular,
`artifacts` and `fan_out` are compiled once into an explicit DBOS workflow plan;
no scheduler or read model may infer cardinality from raw config.

### 2.2 kbbl remains the session owner

Oakridge continues to use kbbl's existing session API for runtime selection,
model/effort, worktree creation, prompts, tool approval, live observation, and
transcripts. DBOS does not launch `claude`, Codex, or another agent CLI directly.

The existing agent artifact callback remains supported:

```http
PUT /executors/delegated_session/:stage_instance_id/units/:unit_id/emit/:output_name
```

Legacy `POST` remains accepted for the same compatibility period as today.
`stage_instance_id` remains the Oakridge StageInstance ID. The adapter resolves
the linked DBOS execution operation internally. `unit_id` remains the
definition-derived unit ID, including `"0"` for a scalar stage.

The create-session payload sent to kbbl must retain current fields and
semantics, including managed worktrees. Existing direct/operator-created kbbl
sessions remain independent of Oakridge.

### 2.3 Operator HTTP compatibility

The kbbl PWA must not be rewritten as part of the backend replacement. Preserve
the current route shapes or provide a compatibility adapter at the same paths:

- workflow definition list/detail/create/archive;
- workflow run create/list/detail;
- run artifacts and artifact revision detail;
- stage detail and delegated-session output emit;
- parked gates, review inbox, gate actions, and stage resume;
- Epic profile, cohort lifecycle, reconciliation, and collaboration routes;
- the existing same-origin kbbl proxy and write-auth behavior.

SSE payload compatibility is preferred. If exact replay semantics cannot be
retained without recreating an event engine, the server may emit invalidation
events that cause the current client to refetch. DBOS history and Oakridge
domain rows remain the sources of truth; no second durable event log is added.

## 3. Prerequisites

### 3.1 kbbl resumable-session primitive for the kbbl adapter

Before the session-backed kbbl executor is cut over from Rust, kbbl must
provide this logical operation:

```text
ensure_resumable_session(session_key, start_spec) ->
  attached(existing_session) |
  started(new_session) |
  terminal(existing_result)
```

Required behavior:

- `session_key` is unique and compare-and-set/idempotent;
- the key is stable across DBOS retries and derived from the Oakridge execution
  ID plus the DBOS executor step/function identity;
- a live session is reattached and awaited;
- a terminal session returns its durable terminal result;
- an unrecoverable orphan is fenced before one replacement is admitted;
- transcript, worktree, output, and process state remain kbbl-owned.

The primitive does not require a kbbl database. Its compare-and-set authority
is a filesystem claim stored beside kbbl's existing session JSONL: the claim
contains the opaque session key, immutable start-spec hash, current kbbl
session ID, and recovery generation. A keyed in-process critical section closes
the claim-to-spawn race for concurrent calls. On restart, terminal JSONL returns
the existing result; a JSONL without a terminal event is treated as an orphan,
fenced, and advances the claim once to a deterministic replacement generation.
When the prior runtime ID and worktree remain recoverable, that replacement
resumes them. Oakridge Postgres may project the resulting session ID for joins,
but it is not the session admission authority.

Until this exists, stub and other executor adapters may be used to implement and
validate the complete DBOS workflow architecture. Only cutover of the kbbl
session-backed executor is blocked. A probe/kill/restart shim is not sufficient
for that adapter's final acceptance test because it has an unavoidable
duplicate-execution window.

### 3.2 PostgreSQL

The TypeScript DBOS SDK is PostgreSQL-only at the version validated by the
spike. Deployment therefore supplies one PostgreSQL service. DBOS owns schema
`dbos`; Oakridge domain tables live in an adjacent `oakridge` schema. Oakridge
code must not write DBOS system tables directly.

## 4. Source domain model

The TypeScript model is ported from the current public Rust/JSON contract, not
invented from implementation convenience. Every structured value has a named
type and every domain ID is branded.

### 4.1 Durable Oakridge entities

```text
Project
WorkflowDefinition
WorkflowRunProfile
WorkflowAttempt
Artifact
ArtifactRevision
GateDecisionAudit
ReviewThread / ReviewMessage / ReviewItem / ArtifactEdit
EpicWorkflowProfile
RepositoryBinding
PullRequestObservation
FinalIntegrationState
DelegatedSessionProjection
```

`WorkflowRunProfile` is Oakridge's stable logical workflow: definition ID and
version, project/context, and Epic profile reference. It is not an
execution-state table. `WorkflowAttempt` links that logical run to one DBOS
root workflow ID, its optional predecessor attempt, and creation metadata.
DBOS remains authoritative for attempt status and fork history.

`DelegatedSessionProjection` stores domain links that DBOS cannot own: stage
instance ID, DBOS execution operation ID, unit ID, kbbl session ID, worktree metadata, logical session key,
and terminal metadata. It is not used for scheduling, child discovery, or
cardinality.

`StageInstance` remains an Oakridge identity. It represents one invocation of a
stage node within a workflow run and has only a domain lifecycle: it starts and
it finishes with an Oakridge outcome. It is not a session, execution unit,
retry attempt, or DBOS workflow. One StageInstance may be implemented by one or
many DBOS workflows and executor invocations.

### 4.2 Execution identity

| Oakridge concept | Authoritative identity/state |
| --- | --- |
| Workflow run | Stable Oakridge `WorkflowRunId`; domain/artifact identity across reruns |
| Workflow attempt | DBOS root workflow ID/status plus `forked_from` lineage |
| Stage instance | Oakridge `StageInstanceId`; lifecycle linked to a DBOS stage coordinator |
| Fan-out unit | Definition-derived `unit_id`; durable execution state in DBOS child history |
| Small stage operation | DBOS step/function ID |
| Stage parent/child relation | DBOS `parent_workflow_id` and operation history |
| Rerun/fork relation | DBOS fork lineage |
| Artifact producer | StageInstance ID, output name, unit ID, and producing DBOS operation |
| kbbl execution | stable session key plus kbbl session ID |

Oakridge and DBOS IDs are linked, never conflated. There is no replacement for
`stage_session_units` as an orchestration ledger.
The engine's child-workflow history is authoritative. The adjacent session
projection exists only to join operator/domain data to kbbl.

### 4.3 Status projection

Oakridge exposes its existing run/stage/unit status vocabulary through pure
selectors over:

- DBOS workflow status and error/output;
- current Oakridge gate event;
- kbbl session projection;
- Epic/PR domain state.

Selectors must not persist a second copy of engine status. If the UI needs a
materialized read model for latency, it is a rebuildable projection with DBOS
workflow ID and observed system-version metadata, never an orchestration input.

The retained StageInstance lifecycle is deliberately small:

```text
pending -> started -> finished(outcome)
```

`outcome` is a typed Oakridge value such as `succeeded`, `failed`, or
`cancelled`. Waiting at a gate, waiting for an input stream, queued execution,
and retrying are DBOS/operator projection states; they are not additional
StageInstance lifecycle transitions. Existing API status vocabulary is produced
by selectors for compatibility.

### 4.4 Artifact-based stage success

Oakridge computes success from the compiled stage contract and accepted
artifacts. The common rules are:

- every required output for every materialized execution unit is present,
  schema-valid, and has satisfied its configured release policy;
- every required incremental input stream has closed without missing a required
  correlated input;
- every declared sibling dependency has reached its configured release outcome;
- no required unit has a terminal failure or cancellation;
- all stage-level gate, handoff, and external conditions are satisfied.

For scalar stages the materialized set is the implicit unit `"0"`. For
`fan_out`, the set is the checkpointed runtime materialization. For `artifacts`,
one executor invocation owns a checkpointed expected artifact set. An empty
fan-out may satisfy its producer stage contract, while a downstream stage with a
required incremental input fails when the empty producer stream closes; this
preserves the current v2 behavior without cardinality inference.

Executor terminal state is handled separately:

- terminal success with an unsatisfied artifact contract is a typed
  `required_output_missing` execution failure;
- terminal failure before contract satisfaction is an executor failure subject
  to the declared retry/rerun policy;
- terminal telemetry received after contract satisfaction is retained for
  diagnostics and adapter cleanup but cannot reverse an accepted immutable
  artifact outcome without an explicit domain reconciliation policy.

## 5. Definition compiler

The definition compiler is a pipeline of typed, independently testable
transforms:

```text
parse definition
  -> validate graph and registered types
  -> validate stage configs
  -> normalize graph semantics
  -> produce immutable CompiledWorkflowDefinition
```

The compiler preserves the definition and emits explicit stage metadata for
runtime use. It must resolve these ambiguities once:

- `artifacts` becomes one executor invocation with a runtime list of artifact
  units; it is not disguised as execution fan-out;
- `fan_out` becomes runtime child-workflow creation from exactly one persisted
  step result;
- `delivery` becomes explicit parent/child workflow dependencies;
- inherited unit correlation uses the declared unit ID and artifact provenance,
  never artifact counts or latest-row heuristics;
- complete/batch dependency DAGs are validated before any execution child is
  started; incremental DAG fragments follow the validation rules in §6.3.

The compiled model separates domain policy from execution configuration:

```ts
interface CompiledStageContract {
  readonly stageKey: StageKey;
  readonly stageType: StageTypeId;
  readonly inputContracts: ReadonlyArray<CompiledInputContract>;
  readonly outputContracts: ReadonlyArray<CompiledOutputContract>;
  readonly materialization: ScalarMaterialization | ArtifactCollectionMaterialization | FanOutMaterialization;
  readonly executor: CompiledExecutorSelection;
  readonly success: CompiledStageSuccessContract;
}

interface MaterializedExecutionUnit {
  readonly unitId: UnitId;
  readonly parameters: JsonValue;
  readonly dependsOn: ReadonlyArray<UnitDependency>;
  readonly executorRequest: ResolvedExecutorRequest;
}

type UnitDependencyRelease =
  | { readonly kind: 'artifact_released'; readonly outputName: OutputName }
  | { readonly kind: 'handoff_accepted'; readonly outputName: OutputName }
  | { readonly kind: 'external_condition'; readonly conditionType: ExternalConditionTypeId };
```

The concrete TypeScript definitions must be ported from the Rust v2 JSON types
and registered artifact/stage contracts before implementation begins. The
illustrative types above establish boundaries but do not authorize inventing a
second config vocabulary.

Validation of incremental delivery, fan-out, and sibling dependencies is based
on these contracts. It must not require either endpoint stage to use
`delegated_session`; that restriction in the Rust implementation is session
coupling to remove.

Fallible transforms return the local `Result<Ok, DomainError>` type. Exceptions
are caught only at database, filesystem, HTTP, kbbl, and DBOS boundaries and
converted to typed errors carrying operation and entity context.

## 6. DBOS workflow mapping

### 6.1 Root workflow coordinator

One DBOS parent workflow represents one Oakridge workflow run. Its input is a
JSON-serializable immutable launch snapshot:

```ts
interface RunWorkflowInput {
  readonly runId: WorkflowRunId;
  readonly workflowDefinitionId: WorkflowDefinitionId;
  readonly workflowDefinitionVersion: number;
  readonly context: RunContext;
}
```

The root loads the immutable compiled definition in a step and durably
interprets its stage graph. It does not merely walk stages in topological order:
the graph supports incremental `unit_complete` delivery, concurrent branches,
and stages that remain open while downstream work runs.

The root starts one DBOS stage-coordinator workflow for each activated
StageInstance. A stage coordinator sends typed domain signals to the root:

```text
OutputReleased(stage_instance_id, output_name, unit_id, artifact_revision_id)
StageFinished(stage_instance_id, outcome)
```

The root routes released outputs across the compiled edges:

- a `unit_complete` edge delivers each released artifact immediately to the
  correlated consumer stage coordinator, starting that StageInstance on its
  first satisfiable input;
- a `producer_complete` edge delivers the complete ordered collection only
  after the producer StageInstance finishes successfully;
- producer closure is sent explicitly so an incremental consumer can finish or
  report a missing required input after the stream is exhausted.

These signals and child calls are DBOS durable operations. Active-stage sets,
delivered-input sets, and child handles live in replayable workflow state and
DBOS history, not Oakridge scheduling tables.

Activation first runs an idempotent Oakridge step that creates the
StageInstance and records `started_at`, then starts its coordinator with a
deterministic DBOS workflow ID derived from the root operation. When the
coordinator returns, another idempotent Oakridge step records `ended_at` and the
typed outcome. A crash between either pair of operations converges through the
stable Oakridge and DBOS IDs.

The root workflow may interpret the static definition graph, provided replay
with the same compiled definition and checkpointed results issues the same DBOS
operations in the same order. All database reads and other IO occur in steps.

### 6.2 Stage coordinator workflows

Each StageInstance is executed by a linked DBOS stage-coordinator workflow. The
coordinator is an implementation of the Oakridge stage contract; its DBOS
workflow ID is not the StageInstance ID. Scalar execution uses the implicit
unit ID `"0"`. Runtime fan-out uses one DBOS execution-child workflow per
materialized unit while retaining one StageInstance.

Each stage coordinator receives a fully resolved immutable input:

```ts
interface StageWorkflowInput {
  readonly runId: WorkflowRunId;
  readonly rootWorkflowId: RootWorkflowId;
  readonly stageInstanceId: StageInstanceId;
  readonly stageKey: StageKey;
  readonly compiledStage: CompiledStageContract;
  readonly initialInputs: ReadonlyArray<ArtifactEnvelope>;
}
```

The stage coordinator receives further incremental inputs through DBOS durable
messages. Configuration resolution and unit materialization are pure transforms
invoked from DBOS steps whose return values are checkpointed. A coordinator or
execution child never re-reads "the latest artifacts" to determine identity,
cardinality, dependencies, or inputs.

The stage coordinator owns no executor-specific assumptions. It invokes a
registered executor adapter through an executor-neutral request and consumes
artifact notifications and operational outcomes through executor-neutral
results. Optional executor references are metadata only.

### 6.3 Runtime materialization, sibling dependencies, and fan-in

For batch materialization, the only legal execution-cardinality path is:

1. a step loads the approved producer artifacts and returns a typed array;
2. a pure transform validates all IDs, dependency references, bindings,
   prompts, workdirs, and worktrees;
3. the stage coordinator calls `DBOS.startWorkflow(executionUnitWorkflow)` once per returned
   item, with deterministic workflow IDs;
4. DBOS history records the exact materialized children and their stable unit
   IDs;
5. the coordinator starts a unit only after its declared sibling dependencies
   have produced their required Oakridge release outcomes and queue capacity is
   available;
6. fan-in reads the durable child results keyed by `unitId` after the declared
   completion condition is met.

For incremental `unit_complete` materialization, each arriving unit definition
is immutable and checkpointed. Duplicate IDs, self-dependencies, and cycles in
the known subgraph fail immediately. A unit may name a dependency that has not
arrived yet and remains unstarted. It becomes runnable only after every named
dependency has arrived and reached its declared release outcome. When the
producer stream closes, unknown dependency IDs and any remaining cycle are a
typed materialization failure. This permits safe incremental progress without
inventing or rediscovering final cardinality.

Do not use `Promise.all` for workflow children. Do not count artifacts,
sessions, or projection rows to infer expected children. Do not maintain a
separate "units expected/completed" table.

`max_parallel` maps to DBOS queue/concurrency policy. Dependency-linked units
are started by the deterministic stage-coordinator workflow. Ready nodes are a
pure derivation from the checkpointed materialization and durable child/domain
release results. This is workflow code executed and recovered by DBOS, not an
Oakridge scheduler. It never polls application tables or executor resources for
readiness.

Manual admission is also an Oakridge contract condition expressed as a durable
DBOS wait. An operator command releases the selected execution unit; it does not
write unit status or cause an application scheduler to scan for work.

Sibling dependencies are not necessarily satisfied by executor termination.
The dependency condition is part of the Oakridge contract and may be an
approved artifact, an accepted handoff, a merged PR, or another typed domain
outcome. DBOS durably waits for that outcome.

For `unit_complete`, the producer's released per-unit artifact is routed by the
root to the correlated downstream stage while the producer StageInstance may
remain open. The consumer StageInstance remains open until all of its upstream
incremental streams close and its own materialized units satisfy their output
contracts. For `producer_complete`, the root waits for producer success and
passes the complete ordered artifact envelope collection.

The retained `artifacts` config means one executor invocation may produce a
runtime collection of independently addressable artifacts. It does not imply N
executor invocations. The retained `fan_out` config requests N execution units.
The compiler preserves this distinction.

### 6.4 Executor-neutral execution contract

The DBOS execution-child workflow calls an executor adapter with a typed,
executor-neutral request:

```ts
interface ExecutionRequest {
  readonly executionId: ExecutionId;
  readonly stageInstanceId: StageInstanceId;
  readonly unitId: UnitId;
  readonly executorType: ExecutorTypeId;
  readonly resolvedConfig: ResolvedStageExecutionConfig;
  readonly inputs: ReadonlyArray<ArtifactEnvelope>;
  readonly declaredOutputs: ReadonlyArray<OutputContract>;
}
```

The adapter may start or attach to external work and returns opaque operational
metadata. It does not decide whether the stage or unit succeeded. A kbbl
adapter may return a session reference; a future LBC adapter may return a run
reference; a stub may return no external reference.

An execution-child workflow performs:

1. invoke the selected adapter idempotently;
2. accept artifact emission notifications through durable messages;
3. validate and persist artifacts through Oakridge steps;
4. evaluate each artifact against the declared output, gate, review, handoff,
   and external-wait contract;
5. publish released artifacts to its stage coordinator;
6. finish only when the required artifact contract is satisfied or a typed
   terminal failure/cancellation policy applies.

Executor termination is evidence about the execution mechanism, not proof of
stage success. A successful kbbl session with missing required artifacts does
not satisfy the execution unit. Conversely, an artifact may satisfy the
contract before an executor emits its terminal telemetry; the adapter-specific
cleanup policy then applies.

Every adapter defines `start_or_attach`, `cancel_or_fence`, and terminal
observation behavior. Calls and callbacks use the stable `executionId` as their
idempotency namespace. The initial kbbl adapter implements `start_or_attach`
using `ensure_resumable_session`; kbbl session details remain inside that
adapter.

### 6.5 Gates and resume

The workflow publishes a queryable event before waiting:

```ts
await DBOS.setEvent('gate-state', pendingGateState);
const command = await receiveGateCommandWithoutDomainExpiry();
```

`receiveGateCommandWithoutDomainExpiry` uses the SDK's supported durable receive
primitive. If the SDK requires a finite receive timeout, it renews the receive
deterministically; timeout is never interpreted as an Oakridge gate outcome.

The existing resume/gate endpoint remains a domain boundary. It:

1. authenticates the operator;
2. loads the artifact and review state;
3. validates the requested action against `output_gate` policy;
4. enforces open-review-item and revision-target rules;
5. inserts or reuses `GateDecisionAudit` by idempotency key;
6. enqueues an idempotent outbox command addressed to the DBOS execution
   workflow waiting on the gate;
7. returns `202` for an accepted command and `409` for an invalid/closed gate.

The outbox delivers the command with the external `DBOSClient.send` API and records delivery
idempotently. It is a transactional boundary adapter only: it does not choose
work, evaluate readiness, count units, or recover workflows. A unique decision
claim per gate prevents two distinct commands from being accepted. After
consuming a command, the workflow publishes a non-pending gate state before
continuing.

The endpoint does not set stage status. `setEvent` is outbound workflow state;
it is not the resume command. Gates have no automatic expiry and survive
application/database restarts and multi-day waits.

### 6.6 Output handoff and external waits

`output_handoff` remains Oakridge policy. The producing child returns the
artifact and handoff descriptor. The parent starts/correlates the downstream
role by declared unit ID. External waits such as `github_review` use the same
publish-event plus receive-command pattern. PR validation and reconciliation
remain Oakridge domain steps.

### 6.7 Rerun and fork

- rerun one unit: fork the exact failed execution child from step zero and send
  its replacement ID to the still-durable owning stage workflow;
- rerun an entire stage: create a new DBOS root `WorkflowAttempt` with
  `resume_from_stage`; the workflow derives graph ancestors and loads their
  persisted artifacts before running the selected stage and descendants;
- preserve earlier spec/plan work as immutable artifacts, not reconstructed
  scheduler state;
- the operator endpoint identifies only the run/stage or StageInstance/unit;
  workflow code retains ownership of runtime cardinality and sibling ordering;
- expose fork lineage in run detail.

`WorkflowRun` remains the stable logical run. A whole-stage rerun creates a
linked `WorkflowAttempt`; a unit rerun remains within the current attempt and
preserves the StageInstance's single start/finish lifecycle. Prior attempt and
child history is immutable. Application code does not reconstruct cardinality
or create an ad hoc continuation state machine.

## 7. Persistence and query surface

### 7.1 DBOS-owned state

The implementation may read supported DBOS APIs or system tables for
projections, including:

- `workflow_status`;
- `operation_outputs`;
- `workflow_inputs`;
- `notifications`;
- `workflow_events` and `workflow_events_history`;
- `workflow_queue` and `queues`;
- `workflow_schedules` and `scheduler_state`;
- `streams`;
- `application_versions`;
- `event_dispatch_kv`;
- `dbos_migrations`.

Writes go through DBOS APIs only. SQL projections must be isolated behind a
typed repository so SDK/schema changes have one compatibility boundary.

### 7.2 Oakridge-owned state

Port the existing domain tables to PostgreSQL under `oakridge`, retaining IDs
and response semantics where practical. Do not port these obsolete execution
tables as authoritative state:

- scheduler-derived `workflow_run.status` bookkeeping;
- scheduler/recovery fields attached to `stage_instance`;
- `stage_session_units` completion/admission bookkeeping;
- scheduler recovery, heartbeat, stuck-stage, or event-log tables.

Keep or reshape tables for definitions, launch profiles, artifacts/revisions,
gate audit, collaboration, Epic profiles, repository/PR state, and kbbl session
links.

Retain `StageInstance` as an Oakridge domain record with start and finish facts,
the stage contract snapshot, and its final typed outcome. Its DBOS coordinator
workflow ID is a link, not its identity or a copied engine status. Do not add
per-unit status rows for orchestration. Unit execution/status/history comes from
DBOS child workflows; executor references are optional projections.

### 7.3 Core read models

| UI view | Source |
| --- | --- |
| Run list | root `workflow_status` joined to definition/run profile |
| Run detail | parent/child workflow status and operation history joined to artifacts and sessions |
| Stage status | StageInstance lifecycle/outcome joined to its DBOS coordinator status |
| Unit status | selector over DBOS execution children, gate events, artifacts, and optional executor projection |
| Pending gates | `workflow_events` gate state joined to artifact/review policy |
| Artifact detail | Oakridge artifact revision and collaboration tables |
| Cohort lifecycle | declared unit IDs, child lineage, artifacts, and validated PR observations |
| Session/worktree links | Oakridge delegated-session projection joined to kbbl identifiers |

No read model may influence scheduling or recovery.

## 8. API behavior details

### 8.1 Create run

`POST /workflow_runs` retains current validation and Epic-branch preflight. It
reserves deterministic Oakridge run and DBOS root IDs, then durably enqueues
the root workflow with the immutable domain launch input. Retrying the same
request returns the same DBOS root.

The root workflow's first idempotent step inserts or verifies `WorkflowRun` and
`WorkflowAttempt`. This makes DBOS enqueue the crash boundary: after DBOS has
accepted the request, recovery owns the domain checkpoint and execution. There
is no database-commit/enqueue gap, launch outbox, polling dispatcher, or
process-local recovery loop in Oakridge.

### 8.2 Artifact emit

Artifact identity is the tuple:

```text
(stage_instance_id, execution_id, unit_id, output_name, emission_idempotency_key)
```

`execution_id` and its DBOS workflow ID are deterministic products of the
StageInstance coordinator operation and `unit_id`. The callback route can
therefore resolve and validate its target without a mutable unit-discovery
table.

The same idempotency key and same payload returns the existing artifact ID. The
same key with a different payload returns `409 idempotency_conflict`. A changed
intentional body uses a new key and explicit revision intent, creating a
revision linked by `parent_artifact_id`. The route validates the
stage's declared output and artifact type before writing. After commit it sends
an outbox command to the linked execution workflow identifying the artifact
revision; retries are harmless.

### 8.3 Cancellation

Cancellation uses DBOS workflow cancellation for the root, StageInstance
coordinator, or selected execution child. The selected executor adapter then
cancels/fences any linked external work idempotently. Cancellation does not
depend on an in-memory handle map and does not assume an external session
exists.

### 8.4 Authentication and deployment surface

Preserve `OAKRIDGE_CORE_BIND`, `OAKRIDGE_CORE_PORT`,
`OAKRIDGE_CONTROL_TOKEN`, `ALLOW_INSECURE_NON_LOOPBACK_CONTROL`, CORS behavior,
`KBBL_API_BASE_URL`, and `OAKRIDGE_PROMPTS_DIR` semantics. Replace
`OAKRIDGE_CORE_DB` with a PostgreSQL URL configuration and document the
compatibility break explicitly. The kbbl proxy remains the normal browser
entry point.

## 9. Workflow code constraints

Every workflow module must follow these mechanical rules:

- inputs and outputs are named JSON-serializable types;
- replay calls durable operations in the same order for the same inputs and
  checkpointed results;
- database, filesystem, HTTP, process, wall-clock, and nondeterministic work is
  isolated in steps;
- steps are idempotent at their external boundaries;
- child workflows and DBOS communication APIs are called from workflows, not
  steps;
- DBOS durable sleep/time/random primitives are used in workflows;
- complex parallel work uses DBOS durable child handles and supported wait
  primitives (`waitAll` for true fan-in), not `Promise.all`;
- no workflow reads or mutates cross-workflow process-global state;
- any durable-operation-order change uses DBOS patching or a new application
  version.

Add lint restrictions for filesystem/process/network imports in workflow
modules and `Promise.all` in workflows. Code review remains responsible for
semantic determinism and external idempotency.

## 10. Application versioning and gated runs

Use DBOS source-derived application versions by default. A deployment that
changes workflow durable-operation order must not reuse a manual version
string.

Normal deployment is blue/green by workflow version:

1. old executors remain available for old pending/gated workflows;
2. new runs target the latest version;
3. operators can query pending workflows grouped by application version;
4. the old executor is removed only when its workflows drain or are explicitly
   forked to a supported version.

Use `DBOS.patch` only for deliberate, reviewed compatibility transitions. Add a
deployment check that reports gated workflows owned by versions about to be
removed. Draining or explicitly forking those runs is an operator decision.

## 11. Failure semantics

| Failure | Required behavior |
| --- | --- |
| Service crash outside a step | DBOS replays from history; no duplicate children |
| Crash during uncheckpointed kbbl step | Retry calls `ensure_resumable_session` and attaches/returns/fences safely |
| Duplicate artifact callback | Idempotent existing artifact/revision result |
| Duplicate gate action | One audit decision and one effective DBOS message |
| One fan-out child transiently fails | Retry only that child's idempotent step according to policy |
| One child terminates in error | Its dependents remain unstarted/blocked; independent branches finish; the stage coordinator returns the typed aggregate failure required by Oakridge policy |
| Executor reports success without required artifacts | Execution child returns `required_output_missing`; StageInstance cannot succeed |
| Incremental producer closes before a required correlated artifact arrives | Consumer returns a typed missing-input failure after processing already-delivered independent units |
| Invalid dependency DAG/binding/worktree | Fail materialization before starting any unit child |
| Process down while gate pending | Gate remains queryable; command may be persisted and consumed after recovery |
| Breaking code deployed | Old version drains, patch preserves branch, or operator forks explicitly |
| PostgreSQL unavailable | No progress; recovery resumes from durable history when restored |

## 12. Implementation sequence

### Cohort A — typed domain and storage

- Port public workflow, delegated-session config, artifact, gate, Epic, and
  collaboration types to TypeScript from the current Rust/JSON sources.
- Add local `Result` and branded IDs.
- Add PostgreSQL Oakridge schema and repositories for domain-owned tables.
- Port definition validation and immutable seeding, proving v11 round-trips.

Exit: v11 validates, seeds, lists, and returns through compatible endpoints;
there is no workflow execution yet.

### Cohort B — definition compiler and stub execution

- Implement pure binding, prompt, collection, fan-out, and DAG transforms.
- Register DBOS root, StageInstance coordinator, and execution-child workflows.
- Run the v11 shape against stub executors with runtime-N fan-out, gates,
  `unit_complete`, and `producer_complete` coverage.

Exit: child history is the sole cardinality record and restart tests pass.

### Cohort C — kbbl adapter

- Implement the kbbl resumable-session primitive.
- Port the current kbbl client payloads and session projection.
- Wire prompt dispatch, output callback, worktrees, cancellation, and recovery.
- Run one real Claude Code session through kbbl.

Exit: hard-kill during a live session resumes without two admitted executors or
lost terminal output.

The workflow architecture and stub acceptance tests must pass before this
cohort. kbbl resumability is an adapter cutover prerequisite, not a prerequisite
for proving the workflow model.

### Cohort D — gates, artifacts, review, and handoff

- Port artifact revision and collaboration behavior.
- Implement gate events/messages, policy validation, audit idempotency, revision
  requests, output handoff, and GitHub-review wait behavior.

Exit: the existing review UI completes spec/plan/build/assessment actions
without UI changes.

### Cohort E — operator projections and compatibility

- Implement compatible run, stage, unit, gate, inbox, artifact, Epic, PR, and
  collaboration read models.
- Adapt SSE to DBOS/domain invalidation without a second history engine.
- Run existing kbbl Oakridge UI behavior tests against the new service.

Exit: current core operator views work through the existing kbbl proxy.

### Cohort F — versioning, fork, and cutover

- Add version inventory/drain diagnostics.
- Add unit rerun and stage rerun through DBOS forks/replacement children.
- Run restart, upgrade-at-gate, cancellation, and PostgreSQL outage tests.
- Shadow-read representative existing data only if migration is later placed in
  scope; migration is not required by this replacement spec.

Exit: all §13 criteria pass, then startup switches from Rust core to the DBOS
service. Remove Rust only in a later cleanup change.

### 12.1 Implementation decision gates

These are stop/go gates, not requests to redesign the ownership boundary:

1. **Domain-model gate, before Cohort A implementation:** the TypeScript types
   are traceable to Rust v2/JSON sources; StageInstance and WorkflowRun IDs are
   independent of DBOS IDs; executor references are optional.
2. **Workflow-topology gate, before kbbl integration:** the stub vertical slice
   proves scalar execution, incremental `unit_complete`, batch
   `producer_complete`, sibling dependencies, stream closure, artifact-based
   success, and restart recovery with no application execution ledger.
3. **Executor-recovery gate, before kbbl cutover:** kbbl's stable session key,
   attach, terminal-result, and fencing behavior passes the hard-kill test.
4. **Compatibility gate, before Rust retirement:** unmodified v11 config, the
   existing operator PWA, gate/review actions, reruns, and version-drain
   procedures pass acceptance.

Failure at a gate pauses the relevant cohort. It does not authorize restoring a
custom scheduler or making sessions authoritative.

## 13. Acceptance tests

### 13.1 Configuration compatibility

- Load unmodified `dev_flow_v11.json`.
- Assert every delegated-session field resolves identically for representative
  scalar, shared-artifact, build fan-out, and assessor-inherit cases.
- Assert current kbbl create-session payloads, worktree values, prompt contents,
  callback URLs, runtime/model/effort, and yolo/tool-policy values match.

### 13.2 Cardinality and dependencies

- Run plans with N=0, 1, 2, and 20 cohorts.
- For N cohorts, assert exactly N execution-child links in DBOS history and no
  expected-N application column/table.
- Exercise a diamond dependency DAG and independent branches.
- Assert sibling dependencies release only on the configured Oakridge domain
  outcome, not executor/session termination.
- Assert a `unit_complete` consumer begins correlated work before its producer
  StageInstance finishes and remains open until the producer stream closes.
- Assert a `producer_complete` consumer receives the complete, stable ordered
  collection only after producer success.
- Kill/restart during materialization and after a subset completes; assert no
  duplicate children and correct downstream correlation.

### 13.3 Gates and recovery

- Stop the service at each spec, plan, brief, assessment, and external-review
  gate; restart and apply each supported action.
- Leave a gate pending across a multi-day-equivalent clock advance.
- Retry the same gate request and assert one effective transition/audit entry.
- Assert pending gates are queryable without a live executor process.

### 13.4 Live kbbl execution

- Run one real Claude Code stage through kbbl.
- `SIGKILL` the DBOS service while the agent is live.
- Restart and assert the stable logical session reattaches or returns its
  result; no concurrent replacement is admitted.
- Emit the output before/after recovery and prove artifact idempotency.
- Assert session termination alone cannot complete a unit or StageInstance when
  a required artifact contract remains unsatisfied.

### 13.5 Executor neutrality

- Execute the same scalar stage contract with a stub adapter that creates no
  session and prove identical artifact-based stage success.
- Assert run, stage, fan-out, gate, dependency, and rerun workflow code contains
  no kbbl/session branching.
- Assert operator projections tolerate an execution with no external reference.

### 13.6 Fork and upgrade

- Fork one failed build execution child and return it to its durable stage
  owner without rerunning spec/plan or sibling builds.
- Start a linked root attempt at build from persisted ancestor artifacts and
  rerun build plus descendants without application-owned cardinality logic.
- Start a run, park at a gate, deploy a workflow with an inserted step, and
  prove the old version drains or a patch selects the correct branch.
- Show old-version gated-run inventory before an executor is removed.

### 13.7 Operator surface

- Run list, run detail, stage/unit statuses, pending gates, review inbox,
  artifacts/revisions, session/worktree links, and cohort lifecycle render in
  the existing PWA.
- API responses expose DBOS parent/child/fork lineage where relevant.
- Read projections are rebuilt from DBOS plus Oakridge tables and are never
  required to resume execution.

## 14. Delete, retain, and revise

### Delete with the Rust substrate

- `Coordinator`, `RunTask`, runnable-stage discovery, and executor event/control
  channels;
- scheduler-owned input propagation and fan-out-producer inference;
- in-memory `StageHandle` maps and restart reconstruction;
- `stage_session_units` as an execution/admission/completion ledger;
- unit/stage aggregate transition logic used for orchestration;
- stage heartbeats, stuck sweeper, and retry bookkeeping used as recovery;
- durable gate parking/resume state machine;
- custom orchestration event history and SSE replay buffer;
- SQLite as the workflow engine store.

Do not delete the `StageInstance` domain concept. Remove only the custom
execution coupling and scheduler bookkeeping attached to it.

### Retain as Oakridge domain behavior

- workflow-definition JSON and validators;
- stage/artifact types and descriptors;
- binding and prompt semantics;
- projects, Epic profiles, repository identities, PR reconciliation, and final
  integration policy;
- artifacts, revisions, reviews, gates, and audit policy;
- delegated-session and LBC adapters (although the first cutover requires only
  kbbl/Claude Code);
- kbbl proxy, operator API/read models, auth, and UI;
- prompt templates and current run-context contract.

### Revise around DBOS

- run and StageInstance IDs remain Oakridge domain IDs linked to DBOS workflow
  IDs;
- statuses become selectors over engine plus domain state;
- gate endpoints validate policy then send durable commands;
- rerun endpoints invoke DBOS fork/replacement-child operations;
- session records become optional kbbl-adapter projections rather than
  scheduling units;
- deployment tooling becomes application-version drain management.

## 15. Explicit non-goals

- Migrating historical Rust/SQLite runs or definitions.
- Rewriting the kbbl PWA or direct-session subsystem.
- Changing the v11 workflow-definition format.
- Replacing kbbl with direct subprocess execution.
- Adding Codex-path parity before the Claude Code path passes acceptance.
- Production auth, Tailscale policy, HA, backups, or Conductor adoption.
- Preserving internal Rust database schemas or executor traits.

## 16. Open implementation decisions

These decisions do not change the architecture and must be closed before their
own implementation cohort begins:

- final TypeScript package/directory name and build tooling;
- whether read APIs use DBOS public methods exclusively or a version-pinned
  typed SQL adapter for richer projections;
- DBOS queue names and deployment concurrency values corresponding to
  `max_parallel`;
- the first post-cutover executor-adapter use case after kbbl; LBC integration
  remains deferred but must not require workflow-model changes;
- migration/retention policy for historical SQLite data;
- exact SSE compatibility mechanism.

They must not be resolved by adding a scheduler, cardinality table, or recovery
state machine to Oakridge.

## 17. Go/no-go for replacement

Proceed with the replacement in cohorts. Cut over only when:

- the unmodified current workflow config drives equivalent kbbl session
  payloads and operator behavior;
- kbbl's resumable-session contract passes the hard-kill test;
- DBOS history is the only authoritative scheduling/cardinality/recovery state;
- pending gates and all core operator views are queryable after restart;
- version drain and fork procedures are demonstrated;
- no application path rediscovers expected work by counting emitted artifacts,
  sessions, or projection rows after materialization.

If the resumable-session primitive cannot provide fencing/idempotent attachment,
the replacement is blocked at the executor boundary; that is not grounds to
reintroduce custom orchestration.
