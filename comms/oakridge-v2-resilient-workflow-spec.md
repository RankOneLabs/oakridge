# Oakridge v2 resilient workflow specification

Date: 2026-08-28
Status: authoritative; Slices 1–4 implemented, Slices 5–6 remain
Scope: `oakridge-dbos` execution and orchestration substrate
Compatibility: clean break; no general legacy workflow compatibility

## 0. Implementation and Oakridge handoff

The first two slices are implemented on PR #460 in three commits:

1. `fbc8faf` — run-owned records and ask-loop workflows;
2. `8c3db7f` — stable work-order executor publication and runtime wiring;
3. `fcc2934` — review hardening of initialization, attachment ensure, and
   executor-operation identity.

The implemented substrate is:

- branded `RunUnitId`, `WorkOrderId`, record-version, slot-version, and input-
  fingerprint identities;
- persisted `run_unit`, `run_output_slot`, `work_order`, and
  `executor_attachment` records;
- v2 stage identity scoped directly to `(run_id, stage_key)`, with no
  `workflow_attempt` row created for DBOS recovery;
- pure unit, stage, and run decision selectors;
- one transactional `RunRecordRepository` boundary for initialization,
  decisions, immediate artifact publication, executor attachment, observation,
  and cleanup state;
- a bounded ask-loop root that starts independent work-order workflows and
  never retrieves their results to determine domain truth;
- work-order-scoped kbbl idempotency, executor attachment, and cleanup;
- a mechanism-level `ExecutorOperationId`: callers derive it from the identity
  they own, while executor adapters know nothing about attempts, work orders,
  parents, or runs;
- capability-scoped artifact publication to a run-owned output slot;
- rejection of conflicting initialization, changed idempotent emissions,
  unauthorized publication, abandoned work, invalidated slots, and ordinary
  replacement of a released slot.

Evidence at handoff:

- TypeScript typecheck passes.
- The complete `oakridge-dbos` suite passes: 436 tests, 0 failures, 982
  assertions on the fresh branch based directly on `main`.
- Two concurrent asks select exactly one work start.
- Re-initialization is idempotent and conflicting initialization is rejected.
- Reconstructing the repository loses no scheduling or settlement state.
- Reusing a work-order identity reattaches to the same kbbl session.
- One work order owns exactly one executor-attachment row.
- Artifact publication replay is idempotent and capability-scoped.
- A released slot completes the run even when cleanup subsequently fails.

Slice 3 landed on the `epic/rock-flows` line as PR #461. Slice 4 is implemented
on `fix/oakridge-v2-slice-4-materialization`, based directly on that Slice 3
tip. The remaining Oakridge scope is exactly Slices 5–6. It must extend these
records and selectors,
not route new behavior back through `production-topology.ts`, execution
replacement projections, semantic child messages, or DBOS result retrieval.

The `epic/rock-flows` Slice 4 tip is the required base for Slice 5. Closed PR
#459 is not a dependency and none of
its legacy coordinator-settlement or DBOS-history-editing code should be
restored. Oakridge must not recover work from that closed branch.

Each remaining slice is one PR. Do not combine slices, start Slice 6 before
Slice 5 lands, or rewrite the Slice 1–4 substrate while implementing a downstream
feature. A foundation change discovered by a failing Slice 3–6 test belongs in
that slice's PR and must preserve the ownership rules in this document.

The old topology is intentionally still the public launch path until Slice 6.
Do not interpret that temporary coexistence as permission to dual-write or add
compatibility logic. The v2 straight-through path currently supports immediate
output release only on the original straight-through compatibility path. The
run-owned path now owns gates, waits, collections, fan-out materialization,
dependency readiness, capacity, manual admission, and revision invalidation.
Operator retry and public clean cutover remain in Slices 5–6. The last legacy
run was cancelled and deleted before cutover; no rescue or adoption path is
required or permitted.

Before adding Slice 3 behavior, add the DBOS process-crash matrix around the
existing v2 workflows: interruption before and after executor ensure, external
start, attachment persistence, artifact commit, and the next root ask. The
storage and external idempotency cases are covered now; deliberate worker
termination is the remaining end-to-end verification of the same Slice 2
mechanism and must not introduce a retry transition to make the test pass.

## 1. Outcome

Oakridge v2 uses DBOS as a durable execution runtime and PostgreSQL as the
authoritative Oakridge domain record.

The governing rule is:

> Workflow code asks the run record what is true and what work is available.
> Children publish facts. Children do not tell parents what those facts mean.

The run is the source of truth. A workflow return value, DBOS event, executor
session, external API, in-memory coordinator map, or reconstructed workflow ID
must never become an alternate source of run state.

This design must make infrastructure retries ordinary:

- DBOS recovers an interrupted workflow from its checkpointed inputs and step
  outputs.
- An interrupted idempotent step can be retried without changing the Oakridge
  domain model.
- A recovered child does not require a replacement projection, parent repair,
  or stale-completion reconciliation.
- A parent restart does not require rebuilding child state from messages.
- A session restart or external API failure cannot revoke facts already
  recorded by the run.

An intentional request to perform new business work is not an infrastructure
retry. It is represented explicitly as a new work order. That distinction is
the only place where Oakridge creates new execution identity.

## 2. Non-negotiable principles

### 2.1 The run owns domain truth

Oakridge's application database owns:

- logical runs;
- stages and units;
- materialized work;
- effective run-level output slots;
- immutable artifact revisions;
- gates, handoffs, and other waits;
- operator decisions;
- business retry requests;
- unit, stage, and run outcomes;
- executor references and observations used for diagnostics.

DBOS owns:

- durable workflow invocation;
- checkpointed workflow and step results;
- automatic recovery;
- step retries;
- durable sleep, receive, queues, and workflow liveness;
- workflow application versions.

No Oakridge query may reconstruct a domain fact from `dbos.workflow_events`,
`dbos.operation_outputs`, workflow return payloads, or workflow-ID grammar.
DBOS status may be read through one infrastructure adapter for observability
and administrative recovery, never to derive a domain outcome.

### 2.2 Ask, do not tell

A parent workflow never accepts semantic commands such as:

- `unit_finished`;
- `unit_failed`;
- `replace_execution`;
- `artifact_released`, interpreted as a settlement instruction;
- `child_says_stage_is_complete`.

A parent asks a domain service for a decision:

```ts
type RunDecision =
  | { readonly kind: "complete"; readonly outcome: RunOutcome }
  | { readonly kind: "start_work"; readonly work_orders: readonly WorkOrder[] }
  | { readonly kind: "waiting"; readonly record_version: RunRecordVersion };

decide_run(run_id: WorkflowRunId): Promise<Result<RunDecision, RunDecisionError>>;
```

The answer is derived from one coherent application-database snapshot.

A child may send a wake-up after committing a fact. The wake-up carries no
domain interpretation. It means only: “the record may have changed; ask
again.” Lost, duplicated, delayed, and out-of-order wake-ups do not affect
correctness.

### 2.3 Children are independent

A child workflow receives an immutable `WorkOrder` and performs that work. It
does not need to know:

- which parent started it;
- whether a parent is currently running;
- whether the run is waiting, retrying, or completing;
- whether another work order superseded it;
- whether downstream work has begun;
- how its facts affect the run contract.

The child publishes facts through domain commands. The domain layer accepts,
rejects, or records those facts according to run-owned invariants.

The child does not send its result to a parent. Its DBOS return value is useful
for tracing and direct callers only; it is not an Oakridge state transition.

### 2.4 External systems are adapters

kbbl sessions, GitHub, local processes, and future executors are mechanisms for
performing or observing work. They may contribute facts. They do not decide:

- whether a unit has fulfilled its output contract;
- whether a stage is complete;
- whether downstream work is ready;
- whether a run succeeded.

External cleanup is never on the acceptance-critical path.

### 2.5 Signals are hints; records are facts

DBOS messages, events, streams, and notifications may improve latency. Every
receiver must remain correct if a signal is duplicated, delayed, or observed
after newer signals. The receiver responds by asking the application record.

Signals must not carry a state transition that exists nowhere else.

## 3. Data model

The schema is implemented before workflow changes. Types mirror these stored
entities; workflows do not invent parallel state shapes.

### 3.1 Workflow run

`WorkflowRun` is the logical operation visible to users.

```ts
interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly workflow_definition_version: number;
  readonly context: JsonValue;
  readonly state: "active" | "succeeded" | "failed" | "cancelled";
  readonly outcome: RunOutcome | null;
  readonly record_version: RunRecordVersion;
  readonly created_at: Timestamp;
  readonly ended_at: Timestamp | null;
}
```

`record_version` increases in the same transaction as every change that can
alter scheduling or settlement. It supports conditional decisions and durable
waiting without making notification delivery authoritative.

The existing logical run ID and public run history remain stable across DBOS
recovery and intentional business retries.

### 3.2 Stage instance

`StageInstance` is one materialized stage in a run. It stores its domain state
directly; its outcome is not decoded from a coordinator workflow result.

```ts
interface StageInstance {
  readonly id: StageInstanceId;
  readonly run_id: WorkflowRunId;
  readonly stage_key: StageKey;
  readonly contract: CompiledStageContract;
  readonly state: "active" | "succeeded" | "failed" | "cancelled";
  readonly outcome: StageOutcome | null;
  readonly materialization_closed: boolean;
  readonly created_at: Timestamp;
  readonly ended_at: Timestamp | null;
}
```

### 3.3 Logical unit

`RunUnit` is the stable owner of work and output slots. It does not become a
new entity because DBOS retries a workflow or an executor process restarts.

```ts
interface RunUnit {
  readonly id: RunUnitId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly state:
    | "ready"
    | "working"
    | "waiting"
    | "satisfied"
    | "failed"
    | "cancelled";
  readonly outcome: UnitOutcome | null;
  readonly created_at: Timestamp;
  readonly ended_at: Timestamp | null;
}
```

The natural uniqueness constraint is `(stage_instance_id, unit_id)`.

`input_snapshot` is the immutable set of inputs for the unit's current
business work. A changed relevant input is not an infrastructure retry; it
creates a new work order after invalidating the affected run output slots.

### 3.4 Run-level output slot

`RunOutputSlot` is the authoritative answer to “what output may this run use
for this unit and declared output name?”

```ts
type RunOutputSlotState =
  | { readonly kind: "empty" }
  | {
      readonly kind: "pending";
      readonly artifact_revision_id: ArtifactId;
      readonly release_wait_id: WaitId;
    }
  | {
      readonly kind: "released";
      readonly artifact_revision_id: ArtifactId;
      readonly released_at: Timestamp;
    }
  | {
      readonly kind: "invalidated";
      readonly previous_artifact_revision_id: ArtifactId | null;
      readonly reason: OutputInvalidationReason;
      readonly invalidated_at: Timestamp;
    };

interface RunOutputSlot {
  readonly run_unit_id: RunUnitId;
  readonly output_name: OutputName;
  readonly artifact_type: ArtifactType;
  readonly required: boolean;
  readonly state: RunOutputSlotState;
  readonly updated_by_work_order_id: WorkOrderId | null;
  readonly version: OutputSlotVersion;
}
```

The primary key is `(run_unit_id, output_name)`. Artifact-collection stages may
materialize multiple logical slots; their stored identity includes the
contract's collection key rather than relying on query-time grouping.

Artifact rows remain immutable revision history. The slot points at the one
effective revision. A query never uses “latest released artifact per output”
as a substitute for slot ownership.

### 3.5 Work order

`WorkOrder` represents an intentional request to perform business work.

```ts
type WorkOrderReason = "initial" | "operator_retry" | "input_revision";

interface WorkOrder {
  readonly id: WorkOrderId;
  readonly run_unit_id: RunUnitId;
  readonly reason: WorkOrderReason;
  readonly input_snapshot: readonly ArtifactEnvelope[];
  readonly input_fingerprint: InputFingerprint;
  readonly state: "available" | "started" | "completed" | "abandoned";
  readonly workflow_id: ExecutionWorkflowId;
  readonly created_at: Timestamp;
  readonly completed_at: Timestamp | null;
}
```

The work-order ID is the idempotency identity of the child DBOS workflow.
Starting or recovering the same work order uses the same workflow ID.

There is no application-level “attempt” for DBOS recovery. DBOS recovery
attempts are infrastructure details. A second `WorkOrder` exists only when the
domain intentionally asks for new work.

### 3.6 Executor attachment and observation

Executor details are subordinate records keyed by work order:

```ts
interface ExecutorAttachment {
  readonly work_order_id: WorkOrderId;
  readonly executor_type: ExecutorType;
  readonly external_reference: ExternalExecutionReference | null;
  readonly health: ExecutorHealthObservation | null;
  readonly cleanup_state: "not_needed" | "requested" | "complete" | "failed";
  readonly updated_at: Timestamp;
}

type ExecutorHealthObservation =
  | { readonly kind: "running"; readonly observed_at: Timestamp }
  | { readonly kind: "unresponsive"; readonly detail: string; readonly observed_at: Timestamp }
  | { readonly kind: "ended_succeeded"; readonly metadata: JsonValue; readonly observed_at: Timestamp }
  | { readonly kind: "ended_failed"; readonly code: string; readonly detail: string; readonly observed_at: Timestamp }
  | { readonly kind: "ended_cancelled"; readonly detail: string | null; readonly observed_at: Timestamp };
```

This record supports diagnostics, cleanup, and decisions about whether new
business work should be requested. It never participates in the selector that
decides whether released slots satisfy the unit contract.

### 3.7 Wait

The existing app-owned wait design remains. Gates, handoffs, external waits,
and retry/operator waits are durable Oakridge entities. DBOS workflows supply
waiting mechanics, but their events are not the record.

Every wait stores its command workflow ID when opened. Readers never reconstruct
that ID from naming conventions.

## 4. Authoritative selectors and transitions

Workflow code calls a small domain API. Each fallible operation returns a
`Result`; storage exceptions are converted at the repository boundary.

### 4.1 Unit outcome selector

```ts
interface UnitOutcomeRecord {
  readonly unit: RunUnit;
  readonly required_slots: readonly RunOutputSlot[];
  readonly open_waits: readonly Wait[];
}

type UnitDecision =
  | { readonly kind: "satisfied"; readonly artifacts: readonly ArtifactRevision[] }
  | { readonly kind: "waiting"; readonly waits: readonly Wait[] }
  | { readonly kind: "work_available"; readonly work_order: WorkOrder }
  | { readonly kind: "needs_work"; readonly missing_slots: readonly OutputSlotIdentity[] }
  | { readonly kind: "failed"; readonly outcome: UnitFailureOutcome }
  | { readonly kind: "cancelled"; readonly outcome: UnitCancelledOutcome };
```

`select_unit_decision(record)` is a pure transform.

Rules, in order:

1. A cancelled unit is cancelled.
2. A terminal domain failure is failed.
3. If every required slot is `released`, the unit is satisfied.
4. If a wait can still release a required pending slot, the unit is waiting.
5. If an available or started work order can fill missing slots, work is
   available or in progress.
6. Otherwise the unit needs an explicit new work order.

Executor health and workflow return values are absent from this selector.

### 4.2 Stage decision selector

`select_stage_decision` asks stored units and materialization state:

- materialize any newly available units;
- start available work while capacity permits;
- wait while a unit has actionable work or an open wait;
- succeed when materialization is closed and every unit is satisfied;
- fail or cancel only from stored domain outcomes and policy.

No in-memory `Map<UnitId, UnitRuntime>` is authoritative. Parallelism is
derived from work orders recorded as started and not terminal, with transitions
protected transactionally.

### 4.3 Run decision selector

`select_run_decision` asks stored stages and edges:

- materialize stages whose required input slots are available;
- start available stage work;
- wait while active work or actionable waits remain;
- succeed when every required stage is satisfied;
- fail or cancel according to stored domain outcomes.

The run does not await a stage workflow result in order to learn the stage
outcome.

### 4.4 Atomic decision boundary

Each `decide_*` operation:

1. reads the required domain rows in one transaction;
2. evaluates pure selectors;
3. applies any state transition using row versions or locks;
4. creates idempotent outbox commands for newly selected work;
5. increments `workflow_run.record_version` when the observable decision may
   have changed;
6. returns the named decision.

Two coordinators asking concurrently must converge on the same stored decision
and must not create duplicate work orders.

## 5. Workflow topology

### 5.1 Run workflow

The root workflow is intentionally boring:

```ts
async function runWorkflow(run_id: WorkflowRunId): Promise<RunOutcome> {
  for (;;) {
    const decision = await decideRunStep(run_id);

    if (decision.kind === "complete") return decision.outcome;

    if (decision.kind === "start_work") {
      for (const work of decision.work_orders) {
        await startWorkOrderStep(work);
      }
      continue;
    }

    await waitForRunChange(run_id, decision.record_version);
  }
}
```

`startWorkOrderStep` is idempotent by `work.workflow_id`. It may enqueue or
start independent child workflows. The root does not retrieve their results.

`waitForRunChange` may use a DBOS notification, receive, or bounded durable
sleep. After waking it always calls `decideRunStep`; the signal payload does
not decide anything.

Stage coordinators are optional implementation partitions, not state owners.
If retained for scale, they use the identical ask loop over a stage record.

### 5.2 Unit work workflow

```ts
async function workOrderWorkflow(order: WorkOrder): Promise<void> {
  const executor = await ensureExecutorStep(order);
  await observeOrDriveWork(order, executor);
}
```

Every nondeterministic operation is a DBOS step or child workflow. Step inputs
contain stable idempotency identities. Recovery of the same work order does not
create another session or another artifact.

The workflow may finish, error, or remain pending. None of those DBOS statuses
directly settles the unit. Domain facts committed during the work determine
the next answer returned by `decide_run`.

### 5.3 Artifact publication

An executor publishes an artifact fact using its immutable work-order
capability:

```ts
interface PublishArtifactRequest {
  readonly work_order_id: WorkOrderId;
  readonly capability: WorkOrderCapability;
  readonly output_slot: OutputSlotIdentity;
  readonly artifact_type: ArtifactType;
  readonly body: JsonValue;
  readonly idempotency_key: IdempotencyKey;
}
```

The child does not ask whether it is current and does not interpret parent
state. The domain command atomically:

1. authenticates the work-order capability;
2. loads the work order and target run-owned slot;
3. validates the artifact against the declared contract;
4. applies idempotency;
5. inserts the immutable artifact revision;
6. transitions the slot to `pending` or `released` according to release policy;
7. opens any required app-owned wait;
8. enqueues notifications;
9. increments the run record version.

If domain state no longer permits the publication, the command returns a named
result such as `work_abandoned`, `slot_invalidated`, or
`slot_already_released`. This is the run enforcing its own invariants, not a
child understanding its parent.

### 5.4 Gate and handoff workflows

Gate and handoff workflows wait durably and execute app-owned wait transitions.
They do not keep the only copy of wait state in a DBOS event.

On a decision they commit the wait outcome and output-slot transition in the
application database, increment the run record version, and optionally wake
the run workflow. The run asks again.

### 5.5 Executor observation and cleanup

Executor observers update only `ExecutorAttachment`. Their lifecycle is
independent of unit settlement.

Once a unit becomes satisfied, the domain may create an executor cleanup work
item. A separate cleanup workflow fences the external executor. Failure is
shown as an operational warning and retried independently; it cannot hold the
unit, stage, or run open.

## 6. Retry semantics

### 6.1 Infrastructure recovery

An executor crash, Oakridge process restart, network interruption, or DBOS
worker replacement is handled by DBOS recovery of the same workflow ID.

Required properties:

- deterministic workflow code;
- nondeterministic work isolated in steps;
- idempotent step effects;
- stable idempotency keys at external boundaries;
- no application state transition called “replace attempt” merely because a
  workflow is recovering.

No Oakridge schema row changes merely because DBOS increments its recovery
count.

### 6.2 Step retry

A retry of the same step uses the same operation identity. External adapters
must implement start-or-attach and mutation idempotency from the stable work
order and operation key.

A successful checkpoint is never manually replayed. Application code never
deletes DBOS operation outputs to force a retry.

### 6.3 Operator retry

An operator retry is requested only when the run record says required slots
remain unfilled and no existing work or wait can fill them.

The transaction creates one new `WorkOrder` with reason `operator_retry`.
Already released run-level slots remain released. The new work order is asked
to produce only missing or invalidated slots. Duplicate operator requests with
the same command id return the same work order.

### 6.4 Input revision

A relevant input revision is new business work, not recovery.

The domain transition atomically:

1. records the revised input snapshot;
2. invalidates the unit's effective output slots;
3. closes or supersedes waits tied to invalidated revisions;
4. records durable downstream invalidation facts;
5. creates one new work order with reason `input_revision`;
6. increments the run record version.

The initial policy is conservative: all outputs of the affected unit are
invalidated. Selective dependency-based invalidation is out of scope until the
workflow definition explicitly models output dependencies.

Running or previously satisfied downstream units discover the consequence by
the next domain decision. No upstream child locates or commands downstream
children.

## 7. Scheduling, fan-out, and availability

The existing compiler and pure materialization transforms are retained.
Materialized units and dependencies are persisted as domain rows before work
starts.

Output availability and unit acceptance remain distinct:

- a released slot is available according to its output delivery policy;
- a unit is satisfied when all its required run-owned slots are released;
- a handoff may make an artifact available downstream before the producing
  unit is fully satisfied;
- an open gate or handoff is represented by an app-owned wait;
- a session health observation never changes availability.

The scheduler asks persisted units, slots, edges, and waits to select work. It
does not maintain a second launched/released set inside a workflow closure.

Parallelism admission is an atomic domain operation. If two ask loops race,
the capacity check and `available -> started` transition occur in the same
transaction.

## 8. Idempotency and concurrency invariants

The database and domain transitions enforce:

1. One logical unit per `(stage_instance_id, unit_id)`.
2. One run-owned output slot per declared slot identity.
3. One effective artifact revision per slot.
4. One work order per idempotent business-work request.
5. One artifact effect per `(work_order_id, output_slot, idempotency_key)`.
6. A work order cannot publish outside its unit and declared outputs.
7. A released slot cannot be silently replaced by an ordinary retry.
8. An invalidated slot cannot satisfy a contract until released again.
9. Wait open/close and corresponding slot transitions are atomic.
10. Unit satisfaction is persisted only if the locked slot snapshot satisfies
    its contract.
11. Stage and run outcomes are derived only from stored domain state.
12. Wake-up delivery is not required for correctness.

Expected concurrency outcomes are discriminated `Result` variants, not thrown
exceptions: `already_applied`, `stale_record_version`, `work_abandoned`,
`slot_already_released`, and `idempotency_conflict`.

## 9. Application-version changes

New workflow code follows DBOS's supported recovery model:

- compatible changes preserve the durable call sequence;
- breaking in-flight changes use DBOS patching where supported and justified;
- otherwise old application versions drain their own pending workflows;
- new work is routed to the new version;
- no tool rewrites `dbos.workflow_status.application_version`;
- no tool deletes `dbos.operation_outputs` or workflow events.

Because this update is a clean break, the new root and child workflow names are
versioned as new workflow definitions. Old topology workflows are not expected
to replay through new topology code.

## 10. Compatibility and deletion boundary

### 10.1 Retained

- workflow definition format and compiler, except where a stored slot identity
  must become explicit;
- artifact bodies and immutable revision chains;
- release policies, gates, handoffs, review, and collaboration domain behavior;
- app-owned wait entity;
- operator-facing logical run IDs and HTTP concepts;
- kbbl as an executor adapter;
- pure materialization, contract, and presentation transforms;
- existing tests that assert domain behavior rather than old topology details.

### 10.2 Replaced

- coordinator-owned `UnitRuntime` as authoritative state;
- child result relays and `unit_finished` settlement messages;
- mutable execution projection as the source of current work;
- `replace_execution` orchestration;
- settlement assembled from workflow return values and executor observations;
- “latest released artifact per execution” settlement queries;
- application-domain state stored only in DBOS events;
- raw DBOS-table joins used to infer Oakridge state;
- external cancellation in the acceptance-critical path.

### 10.3 Deleted

- general legacy replay compatibility;
- dual-write migration scaffolding after cutover;
- the `resettle-parked-coordinator` DBOS-history surgery utility;
- tests whose only purpose is preserving old coordinator message choreography.

## 11. Clean-cutover boundary

There are no legacy runs to rescue. The last legacy run was explicitly
cancelled and deleted and the old server was stopped before v2 cutover work
continued.

Production cutover therefore starts from an empty Oakridge application
database. Numbered migrations may still construct that fresh schema, but no
migration may claim to convert a pre-v2 run into a valid v2 run record. In
particular, defaults for new state, release policy, admission, or
materialization fields are schema-construction details only; they are not a
backfill contract.

The cutover procedure must:

1. keep the old server and all old DBOS workers stopped;
2. archive any operator data required outside the live service;
3. recreate the Oakridge application database;
4. apply the schema from zero and seed current definitions/configuration;
5. use a new DBOS application version and only the v2 workflow names;
6. launch no old topology workflow and run no adoption or rescue command.

An in-place deployment over a database containing legacy runs is unsupported
and must stop before serving traffic. It must never silently reinterpret old
terminal rows as active v2 rows.

## 12. Implementation sequence

The work is delivered as vertical slices. Each slice ends in runnable behavior,
not a second dormant architecture beside the old one.

### Slice 1 — Domain record and one straight-through unit — implemented

1. Add branded IDs and named types for `RunUnit`, `RunOutputSlot`, `WorkOrder`,
   `ExecutorAttachment`, and record versions.
2. Add schema, constraints, repositories, and transactional domain commands.
3. Implement pure unit/stage/run decision selectors.
4. Implement the ask-loop root and independent work-order child.
5. Prove one unit can publish a released artifact, satisfy its slot, and make
   the run complete across process restarts.

No gates, retries, fan-out, or external sessions are needed to validate the
first slice.

### Slice 2 — Real executor and free recovery — implemented; crash matrix required at handoff

1. Connect kbbl through work-order-scoped idempotency.
2. Store executor attachment by work order.
3. Recover the Oakridge process and DBOS worker at every executor boundary.
4. Prove the same work order attaches to the same external operation and does
   not require projection replacement.
5. Separate cleanup workflow from acceptance.

### Slice 3 — Gates, handoffs, and waits — implemented in PR #461

1. Connect artifact publication to the app-owned wait store.
2. Make gate/handoff decisions commit slot transitions.
3. Replace semantic workflow messages with record-version wake-ups.
4. Prove an executor may end or become unresponsive while a wait remains
   actionable and the run still progresses after the decision.

### Slice 4 — Fan-out, dependencies, and revisions — implemented

1. Persist compiler-materialized units and dependency edges.
2. Implement transactional capacity admission.
3. Drive downstream readiness from available slots.
4. Implement conservative unit-slot invalidation for revised inputs.
5. Prove released downstream work is reconsidered by asking the record, without
   an upstream child commanding it.

Implementation evidence: compiler-produced units, forward dependency edges,
collection-member slot identities, scheduling policy, manual admission, and
fully resolved execution requests are persisted as run-owned records. Stage
close validates unknown dependencies and cycles. Selection, capacity
reservation, work start, transition append, and one record-version increment
commit in one transaction. Input revision abandons superseded work, withdraws
open waits, invalidates every slot owned by the unit, and creates the replacement
work order in one transaction. Typecheck and the checkout-local suite pass (480
tests, 0 failures, 906 assertions); PostgreSQL-backed cases require the normal
reachable test database and otherwise skip.

### Slice 5 — Operator retry and failure policy

1. Create idempotent operator-retry work orders only for recorded missing work.
2. Preserve released slots across retry.
3. Surface executor diagnostics without allowing them to override contract
   satisfaction.
4. Prove infrastructure recovery needs no retry-specific domain transition.

### Slice 6 — Clean cutover

1. Stop launching the old topology for new runs.
2. Require an empty v2 application database and seed current configuration.
3. Delete the old topology, projection replacement, relay settlement, and
   DBOS-history surgery code.
4. Prove new workflow definitions cannot replay old topology histories.

## 13. Required tests

### 13.1 Recovery is free

- crash before a step begins;
- crash during an idempotent external step;
- crash after external success but before checkpoint acknowledgement;
- crash after artifact commit but before wake-up;
- crash after wake-up but before the parent asks again;
- restart parent while children continue independently;
- duplicate start of the same work-order workflow;
- duplicate artifact publication with the same idempotency key.

None may create a second logical work order or require projection replacement.

### 13.2 Ask-based correctness

- lost wake-up still progresses after bounded wake/recheck;
- duplicate and out-of-order wake-ups do not alter outcome;
- child returns success without output and the unit remains unsatisfied;
- child returns error after releasing every required slot and the unit is
  satisfied;
- external session reports unresponsive while a gate is open and the gate
  remains the operator action;
- executor cleanup fails after satisfaction and downstream work still starts;
- no test needs a child completion payload to calculate a domain outcome.

### 13.3 Output slots

- ordinary retry preserves released slots and fills only missing slots;
- two work orders cannot accidentally combine outputs unless the run-level
  slots explicitly preserve those outputs;
- changed emission against an already released slot is rejected outside an
  input-revision transition;
- input revision invalidates every output of the unit;
- invalidated outputs stop satisfying downstream contracts immediately;
- a new revision forms immutable artifact history while the slot points only
  at the effective revision;
- artifact-collection slot identities are explicit and collision-free.

### 13.4 Concurrency

- two ask loops create one work order;
- capacity admission cannot exceed stage parallelism;
- publication racing invalidation produces one typed, valid outcome;
- settlement racing a gate decision converges on the slot record;
- cancellation racing publication cannot produce a satisfied cancelled unit;
- operator retry command replay returns the same work order.

### 13.5 Versioning and cutover

- new workflow definitions never replay old topology histories;
- no production or cutover code mutates DBOS operation history;
- an in-place cutover with legacy runs is refused;
- a fresh database migrates and seeds from zero;
- no rescue, adoption, or legacy-run backfill code ships.

## 14. Observability

Operator projections read Oakridge domain tables. They show independently:

- logical unit decision;
- required output-slot state;
- open actionable waits;
- available or running business work orders;
- executor health;
- executor cleanup warnings;
- DBOS workflow liveness as infrastructure metadata.

“Stuck” means the domain record has no available work, no work in progress, no
actionable wait, and is not terminal. Silence alone is not stuckness. A pending
human gate is waiting, not stuck. Cleanup failure is a warning, not a failed
run.

Every transition log carries `run_id`, `stage_instance_id`, `run_unit_id`,
`work_order_id` where applicable, prior record version, and resulting record
version. External session identifiers are diagnostic fields only.

## 15. Definition of done

This update is complete when:

- a run's outcome can be derived exclusively from Oakridge domain rows;
- every workflow coordinator makes progress by asking a named domain decision;
- children publish facts without knowing parent state or addressing parent
  workflows;
- infrastructure recovery of a work order requires no Oakridge retry or
  replacement transition;
- released run-level output slots, not sessions or workflow returns, decide
  unit satisfaction;
- gates, handoffs, retries, revisions, and cleanup remain correct across
  restarts and duplicate delivery;
- no Oakridge domain query reconstructs state from DBOS private tables or event
  payloads;
- no external API call can block acceptance of an already satisfied unit;
- all new-run end-to-end tests pass with deliberate crashes at each durable
  boundary;
- the clean database cutover is documented and verified;
- old coordinator/relay/projection-replacement and DBOS-history surgery code
  has been deleted.

## 16. Explicit non-goals

- General migration or replay compatibility for old topology workflows.
- Preserving old coordinator workflow IDs.
- Treating DBOS workflow history as the Oakridge audit log.
- Selective per-output invalidation before dependencies are declared in the
  workflow definition.
- Making executor cleanup transactional with unit acceptance.
- Inferring a domain outcome from a session, process, GitHub request, workflow
  return value, or timeout.
- Building another scheduler, retry engine, or child-lifecycle protocol on top
  of DBOS.

## 17. Supersession note

For execution and orchestration behavior, this document supersedes the topology
described in `comms/oakridge-dbos-backend-replacement-spec.md`, the phased
compatibility strategy in `comms/oakridge-dbos-correction-plan.md`, and any
follow-up that requires coordinator-owned unit state, semantic child-completion
messages, mutable execution replacement projections, or DBOS-history surgery.

The domain ownership conclusions in `comms/state-boundary-audit.md` and the
app-owned wait design remain valid and are incorporated here.
