# DBOS Transact as the Oakridge workflow substrate

Date: 2026-08-13
SDK tested: `@dbos-inc/dbos-sdk` 4.25.14
Decision: **Go**

DBOS can replace Oakridge's scheduler, fan-out materialization, durable waits,
checkpoint/recovery loop, and workflow history. Oakridge should remain the domain
layer: named stage workflows, artifact/review tables, executor adapters, policy,
and operator-facing query/API projections.

The two implementation follow-ups are not alternate orchestrators:

1. kbbl needs a resumable-session contract before a live agent subprocess can be
   retried safely after an executor crash. This contract has now been implemented
   as an idempotent filesystem-backed resumable-session boundary.
2. Oakridge needs a thin operator projection over DBOS system tables. In
   particular, a pending review gate must be published as a workflow event because
   an incomplete `recv` is not itself exposed as a row that says "pending gate."

No spike result requires Oakridge to infer fan-out cardinality or reimplement
scheduling/recovery.

## What was exercised

The throwaway TypeScript program implemented:

```text
spec step -> plan step -> runtime-N build child workflows
          -> durable approval receive -> review step
```

The plan step returned the typed runtime value `Plan.items: BuildItem[]`. The
parent started one registered child workflow per item, waited with
`DBOS.waitAll`, and read each handle's result. Each build child wrapped a
subprocess in a DBOS step. Spec, plan, build, and review wrote rows to an
adjacent `oakridge.artifacts` table keyed by DBOS workflow and function IDs.

Observed runs included:

- a three-child runtime fan-out with child IDs and parent links recorded by DBOS;
- approval before and after a process restart;
- an OSS CLI fork from function ID 2 that retained spec/plan checkpoints and
  reran the build children;
- a hard process kill during a live `claude -p` step, followed by recovery;
- application-version and workflow-change behavior;
- direct SQL inspection of the installed `dbos` schema.

The original disposable validation source briefly lived at
`/tmp/oakridge-dbos-spike` locally and on `willie`; it is not part of this
repository. That remote validation environment is not the replacement runtime:
Oakridge/DBOS runs locally.

## 1. Gate mapping

**Answer: clean, but the inbound primitive is `recv`/`send`, not `setEvent`.**

The workflow waits with a long timeout (or an absolute deadline):

```ts
const decision = await DBOS.recv<GateDecision>('gate-approval', {
  timeoutSeconds: 604_800,
});
```

The HTTP endpoint sends the decision from ordinary TypeScript:

```ts
app.post('/runs/:id/approve', async (req, res) => {
  await dbosClient.send(
    req.params.id,
    { action: 'approve', comment: req.body.comment },
    'gate-approval',
    req.body.idempotencyKey,
  );
  res.status(202).json({ accepted: true });
});
```

`DBOS.setEvent` is callable only from inside a workflow and publishes workflow
state for external readers. It cannot replace the approve endpoint. The useful
mapping is:

- command into workflow: external `DBOSClient.send` -> workflow `DBOS.recv`;
- queryable gate state out of workflow: `DBOS.setEvent('gate-state', ...)` ->
  `DBOS.getEvent` or SQL.

The test stopped the process while a workflow was waiting, restarted the same
application version, sent approval, and observed `SUCCESS` with
`recoveryAttempts = 2`. Notifications and receive checkpoints are in Postgres,
so a days-long wait survives process/database downtime under DBOS's documented
recovery assumptions.

`POST /stage_instances/:id/resume` collapses to `send`, including an
idempotency key. Residual scheduler state is unnecessary. Residual *domain and
presentation* state remains useful: artifact revision, permitted actions,
operator comment, and a `gate-state` event so SQL can list pending gates.

Sources: [workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication),
[workflow recovery](https://docs.dbos.dev/production/workflow-recovery).

## 2. Runtime fan-out cardinality

**Answer: yes for execution and recovery; manual replacement is an explicit
management operation, not implicit inference.**

The cardinality source was solely the persisted plan-step return value. The
parent enumerated that array once to start children. DBOS assigned durable child
IDs, stored `parent_workflow_id`, recorded each child call in
`operation_outputs.child_workflow_id`, waited for handles, and replayed the same
calls from the plan checkpoint after recovery. The observed N=3 run had exactly
three child links (`...-2`, `...-4`, `...-6`) and three build results.

No later Oakridge component counts artifacts, sessions, or rows to rediscover N.
The engine history is authoritative. This makes the current v2 bug class—parent
and per-unit tables disagreeing about materialized cardinality—structurally
absent.

The supported complex-parallel pattern is important:

1. `DBOS.startWorkflow(child)(item)` for each runtime item;
2. `DBOS.waitAll(handles)`;
3. read handle results.

DBOS's own agent guidance says not to use `Promise.all` for complex workflow
execution because multiple rejections are unsafe. The spike was corrected to
the supported pattern.

Partial failure policy has two levels:

- transient executor failure: configure retry on the child step; only that
  child's step retries;
- operator-directed rerun after terminal failure: fork the failed child, then
  fork/continue the parent with the replacement child mapping supported by the
  current SDK's `forkWorkflow(..., { replacementChildren })` API.

The latter requires an explicit operator command identifying the failed child;
it does not require cardinality inference or a scheduler. Oakridge should not
create a second unit-state table.

Sources: [workflow methods and `waitAll`](https://docs.dbos.dev/typescript/reference/methods),
[workflow guarantees](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial).

## 3. Recovery versus a live subprocess

**Answer: DBOS correctly reruns an uncheckpointed step; raw subprocess execution
is not independently idempotent. kbbl needs a resumable-session primitive.**

The spike killed the Node process with `SIGKILL` while the build child had a live
`claude -p` launched through the wrapper. Before restart, the adjacent attempts
table contained one unfinished attempt. After starting the same application
version, DBOS reported `recoveryAttempts = 2` and invoked function ID 0 again.
For a short interval both the orphaned original executor and the recovered
executor existed, with two attempt rows sharing the stable logical session ref
`<child-workflow-id>:<step-id>`.

That is the expected at-least-once boundary: if the process dies after launching
the subprocess but before checkpointing the step result, DBOS cannot know
whether the external work completed.

The required kbbl primitive is:

```text
ensure_resumable_session(session_key, start_spec) ->
  attached(existing_session) |
  started(new_session) |
  terminal(existing_result)
```

Contract:

- `session_key` is the stable DBOS child workflow ID plus step/function ID, not
  an attempt PID;
- creation is compare-and-set/idempotent on that key;
- an existing live session is reattached and its terminal result awaited;
- an existing terminal session returns the recorded result;
- an irrecoverably orphaned session is fenced/killed before exactly one new
  attempt is admitted;
- transcript and output remain kbbl-owned.

Without that primitive, the safe fallback is probe/kill/restart using a durable
session record, but there is an unavoidable uncertainty window. This is the
allowed "kbbl session resumability spec" outcome, not a DBOS blocker.

Source: [DBOS architecture and idempotent-step requirement](https://docs.dbos.dev/architecture).

## 4. Fork and rerun granularity

**Answer: fork is in the OSS TypeScript SDK and CLI; it is not Conductor-only.**

The spike ran:

```text
npx dbos workflow fork epic-runtime-n-3 --step 2 \
  --forked-workflow-id epic-fork-build --application-version v2
```

The new workflow had `forkedFrom = epic-runtime-n-3`, copied function IDs 0 and
1 (spec and plan), and created fresh build children beginning at function ID 2.
Thus "rerun build without rerunning spec/plan" works in OSS.

Implemented mapping in the replacement backend:

- logical Epic/run: stable Oakridge `WorkflowRun`;
- root execution/fork: `WorkflowAttempt` keyed by DBOS root workflow ID;
- independently observable/retriable StageInstance: child workflow;
- small non-independent operations inside a stage: steps.

Unit rerun forks the exact failed execution child from step zero and returns the
replacement ID to the still-durable stage owner. Whole-stage rerun starts a new
linked root attempt with `resume_from_stage`; workflow code derives ancestors
from the compiled graph, loads their persisted artifacts, and executes the
selected stage plus descendants. This avoids DBOS's immutable-fork-input issue:
a root fork cannot change an embedded Oakridge run ID. It also keeps runtime
cardinality inside workflow code rather than an HTTP continuation planner.

Sources: [workflow management](https://docs.dbos.dev/typescript/tutorials/workflow-management),
[OSS CLI fork](https://docs.dbos.dev/typescript/reference/cli).

## 5. Operator data surface

The 4.25.14 installation created these system tables:

| Table | Operator relevance |
|---|---|
| `workflow_status` | run/stage status, inputs/output/error, version, parent/fork lineage, timestamps, attributes |
| `operation_outputs` | ordered steps, output/error, child workflow links, timings |
| `workflow_inputs` | serialized workflow arguments |
| `notifications` | queued/consumed gate messages |
| `workflow_events` | current published state, including `gate-state` |
| `workflow_events_history` | event history by function ID |
| `workflow_queue` | queued executions |
| `queues` | queue configuration |
| `workflow_schedules` | schedules |
| `scheduler_state` | scheduler cursor/state |
| `streams` | durable workflow streams |
| `application_versions` | registered versions and latest-version ordering |
| `event_dispatch_kv` | durable event-receiver offsets/state |
| `dbos_migrations` | system-schema migration version |

Core views are SQL-serviceable:

- run list: parent rows from `workflow_status`, plus current stage projection;
- run detail: parent/child `workflow_status` joined by `parent_workflow_id`,
  `operation_outputs`, and Oakridge artifacts;
- stage status: child workflow status (or named step status for non-child stages);
- pending gates: `workflow_events.value.status = 'pending'`, joined to workflow
  and artifact/review tables;
- session/worktree links: Oakridge/kbbl adjacent tables keyed by workflow ID.

The engine's durable history is queryable. Two qualifications matter:

1. Status is engine vocabulary (`PENDING`, `SUCCESS`, `ERROR`, etc.); Oakridge
   still owns the selector that maps it to operator vocabulary.
2. An incomplete `recv` is not a standalone "pending gate" record in the
   documented table surface. Publishing the gate-state event is required.

Direct reads are suitable for diagnosis and read-only projections; writes must
go through DBOS APIs. The public `listWorkflows`, `listWorkflowSteps`, and event
APIs are a safer compatibility boundary for application endpoints.

Source: [DBOS system database tables](https://docs.dbos.dev/explanations/system-tables).

## 6. Storage backend

**PostgreSQL only. SQLite has not landed in the TypeScript SDK.** The current
configuration accepts a PostgreSQL `systemDatabaseUrl`; the installed SDK uses
PostgreSQL-specific schema types and migrations. The original spike used a
disposable remote container; the replacement proof and intended runtime use a
local PostgreSQL container.

Oakridge artifact/review tables can be adjacent in the same database under an
`oakridge` schema. They remain Oakridge-owned; DBOS system tables remain under
`dbos`. This adds one durable service compared with the current SQLite stack.
The replacement backend uses the `pg` driver, matching DBOS itself. A live
concurrent proof found Bun's experimental SQL client could execute an insert
while leaving its promise unresolved; it is not used as the backend adapter.

Source: [TypeScript configuration](https://docs.dbos.dev/typescript/reference/configuration).

## 7. In-flight code changes

**Breaking workflow changes require DBOS patching or versioned blue/green
drain. Do not deploy them under the same explicit version.**

DBOS identifies a workflow version automatically from workflow source, or from
the configured `applicationVersion`. Recovery only selects workflows whose
version matches the executor. With versioning, retain old-version executors
until their `PENDING`/`ENQUEUED` workflows—including gated Epics—drain. New
traffic goes to the latest version. An approval message may be persisted while
the matching old executor is offline, but progress requires that version to run
again (or an explicit fork to another version).

For a small inserted step, `DBOS.patch('name')` is the alternative: old runs
take the old path, new runs take the new path, and the patch is deprecated and
removed only after old histories drain. An unpatched breaking change can fail
replay with `DBOSUnexpectedStepError`.

Survivable Oakridge policy:

- default: automatic source-derived versions plus blue/green draining;
- maintain an active-version query and alert for gated old versions;
- use a DBOS patch only for deliberately reviewed, short-lived compatible
  transitions;
- never reuse a manually assigned version string for changed workflow code.

Source: [upgrading workflow code](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows).

## 8. Determinism and constraint surface

The rules are small enough for planner2 briefs and review/lint checklists:

- workflow inputs/outputs are JSON-serializable;
- a replay with the same inputs and prior step results must call the same durable
  operations in the same order;
- database/filesystem/network/process/time/random work belongs in steps;
- steps must be idempotent because an uncheckpointed step is at-least-once;
- workflows, not steps, start child workflows or call DBOS communication APIs;
- use DBOS durable time/random/sleep primitives inside workflows;
- use `startWorkflow` + `waitAll` for complex parallel children, not
  `Promise.all`;
- do not mutate cross-workflow in-memory/global state;
- use patching or versioning for any change to durable-operation order;
- keep DBOS external to JS bundlers because registration depends on its runtime
  registry.

These are mechanical enough to include as a fixed "DBOS workflow constraints"
section in every generated build brief. ESLint can catch direct imports of
filesystem/process/network APIs in workflow modules and forbidden
`Promise.all`; review must still check determinism and idempotency semantics.

Sources: [workflow determinism](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial),
[AI-assisted development constraints](https://docs.dbos.dev/typescript/prompting).

## Go/no-go against the stated criteria

**Go.** Questions 1, 2, 3, and 5 have workable answers. Question 3 produces the
permitted kbbl resumability spec. Question 7 has a supported standing strategy:
versioned blue/green drain or explicit patches. No finding requires Oakridge to
own a scheduler, recovery loop, or inferred cardinality.

This is a substrate go. The replacement implementation closes the mapping as:
StageInstance lifecycle is domain-only; a DBOS stage coordinator owns execution
and may contain many execution children. A StageInstance starts once and
finishes once, and is never a session or executor attempt.

### Replacement implementation verification status (2026-08-14)

The substrate decision above remains **go**, but it must not be read as a
cutover-ready claim. The replacement package currently has green local tests
for definition compatibility, runtime cardinality, incremental dependencies,
artifact-driven success, durable gates, executor-neutral workflow code,
kbbl resumable-session fencing, operator SQL projections, cancellation, and
both rerun granularities. Unit and stage rerun command identities are stable
across HTTP retries; a new stage attempt also fences and recursively cancels
the exact predecessor attempt after the successor is recorded.

The full production topology proof passes locally against PostgreSQL 16. It
completed scalar source execution, runtime collection materialization, two
dependency-ordered build children, and incremental assessor children. The DBOS
root and all 20 recorded root/stage/relay/execution/terminal workflows reached
`SUCCESS`. The proof also caught and removed an invalid harness shortcut that
wrote DBOS's private `notifications` table; external delivery now uses the
public `DBOSClient.send` API. Cutover still requires the live kbbl hard-kill and
workflow-version drain exercises from the acceptance matrix.

The package now includes ordered, transactional Oakridge schema migrations and
an executable service composition root. Initial launch durably enqueues the
deterministic DBOS root first; that root's first idempotent step checkpoints the
logical run and attempt, so Oakridge has no database-commit/enqueue crash window
or launch dispatcher.

## Orchestrator-core specification impact

Against `comms/v2/oakridge-orchestrator-core-v2-spec.md` and the later parity
specs:

Delete or replace with DBOS usage:

- persistence of `workflow_run` and `stage_instance` execution state;
- scheduler/runtime loop, runnable-stage discovery, admission, polling, stuck
  sweeper, and restart reconstruction;
- fan-out unit materialization and `stage_session_units` as an execution ledger;
- aggregate unit/stage status computation;
- intra-stage DAG admission and max-parallel scheduling (use child workflows and
  DBOS queues);
- durable gate parking/resume state machine (use `recv`/`send` plus event
  projection);
- retry bookkeeping and recovery probes owned only for orchestration;
- engine event log/SSE as the source of truth (project DBOS history/events).

Survive as Oakridge domain/API code:

- project/repository and typed Epic profile;
- stage definitions, operator roles, artifact type descriptors, and typed
  input/output contracts;
- artifact revisions, review items/comments, approval policy, and audit data;
- executor adapters, prompt rendering, worktree/session metadata, and kbbl/LBC
  contracts;
- PR reconciliation and final-integration policy;
- operator selectors and HTTP projections for run list/detail, review inbox,
  artifacts, sessions, and worktrees;
- authorization, deployment policy, and version-drain operations;
- the new kbbl `ensure_resumable_session` contract.

Revise rather than simply delete:

- logical run and StageInstance IDs remain Oakridge identities linked to DBOS
  attempt/coordinator IDs;
- status types become domain selectors over DBOS statuses;
- gate endpoints validate Oakridge artifact/review policy, then call `send`;
- unit rerun endpoints fork exact children; stage reruns start linked attempts
  from persisted ancestor artifacts;
- lifecycle events become queries/streams derived from DBOS plus Oakridge
  domain tables.
