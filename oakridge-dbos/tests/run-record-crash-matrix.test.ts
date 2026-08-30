/**
 * The DBOS process-crash matrix for `oakridgeV2RunWorkflow` and
 * `oakridgeV2WorkOrderWorkflow`, required before any Slice 3 behavior: every
 * durable step boundary must recover to one committed effect, never a second
 * work order, a duplicated external session, or a repeated artifact.
 *
 * Two complementary techniques prove this:
 *
 * - A repository-level replay proves each step's own effect is idempotent —
 *   the same call twice commits once. This is what DBOS guarantees for a step
 *   whose checkpoint did not commit before a crash: the step function runs
 *   again from scratch, so its *own* idempotency is what recovery depends on.
 * - Two real DBOS runs prove the complementary half: starting the *same*
 *   workflow id a second time — what a restarted process does when it does
 *   not know an earlier attempt already ran — replays DBOS's own cached
 *   outcome rather than re-invoking the workflow body, so no step re-runs and
 *   no external session is re-attached.
 *
 * No test here introduces a retry or replacement transition: every case is
 * satisfied by the repository idempotency the run-record substrate already
 * has, exactly as the spec requires.
 *
 * A literal killed-process crash — interrupting a step or a durable sleep by
 * force, mid-execution, rather than by the workflow returning — is not
 * exercised in this file; the same in-process `DBOS.shutdown()` limitation
 * the last test below works around could not simulate it either. See
 * `run-record-process-crash.test.ts` for that: a real OS-process kill/restart
 * harness covering the boundaries a repository-level replay cannot reach.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { AskResult } from "../src/decision/commands";
import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../src/domain/execution";
import type { ArtifactId, InputFingerprint, Result, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import type { RunRecordRepositoryError } from "../src/storage/repositories";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { registerRunRecordWorkflowServices, runRecordWorkflow, runRecordWorkOrderWorkflow } from "../src/workflows/run-record-topology";
import { awaitCondition } from "./support/dev-flow-harness";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

const skip = (): void => console.warn("run-record crash-matrix test SKIPPED: no PostgreSQL reachable");

/**
 * A run now completes over several back-to-back asks (a fact -> `recheck`,
 * its consequence -> `recheck`, run complete) rather than one: each ask
 * commits from persisted truth alone, so this drives to a terminal decision
 * instead of assuming one call reaches it.
 */
const decideUntilSettled = async (records: PostgresRunRecordRepository, runId: WorkflowRunId, at: string): Promise<Result<AskResult, RunRecordRepositoryError>> => {
  for (let asks = 0; asks < 10; asks += 1) {
    const decision = await records.decide_run(runId, at);
    if (!decision.ok || decision.value.kind !== "recheck") return decision;
  }
  throw new Error(`decide_run for run '${runId}' did not settle within 10 asks`);
};

interface FreshUnit {
  readonly records: PostgresRunRecordRepository;
  readonly runId: WorkflowRunId;
  readonly workOrderId: WorkOrderId;
  readonly workOrderWorkflowId: string;
  readonly capabilityHash: string;
  readonly now: string;
}

/** One straight-through run with a single immediate-release unit, freshly initialized. */
const freshUnit = async (executorType = "crash-matrix-executor"): Promise<FreshUnit | null> => {
  if (!sql) return null;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`secret-${workOrderId}`).digest("hex");
  const workOrderWorkflowId = `v2-work:${workOrderId}`;
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `crash-matrix-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: workOrderWorkflowId, stage_key: "build", executor_type: executorType,
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    created_at: now,
  });
  return { records, runId, workOrderId, workOrderWorkflowId, capabilityHash, now };
};

// ---------------------------------------------------------------------------
// Repository-level replay: the effect at each durable step boundary is
// idempotent, so DBOS re-running a step from scratch after a crash commits
// once, whichever side of the boundary the crash fell on.
// ---------------------------------------------------------------------------

test("crash matrix: root decide before and after the start_work transition commits once", async () => {
  const unit = await freshUnit();
  if (!unit) return skip();
  const { records, runId, now } = unit;
  // Before: nothing has decided yet. A second repository instance racing the
  // first is exactly "two recoveries of the same crashed step".
  const raced = await Promise.all([records.decide_run(runId, now), new PostgresRunRecordRepository(sql!).decide_run(runId, now)]);
  expect(raced.filter((decision) => decision.ok && decision.value.kind === "recheck")).toHaveLength(1);
  const started = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE id = $1 AND state = 'started'", [unit.workOrderId]);
  expect(started[0]?.count).toBe("1");
  // After: replaying the already-applied decision (a recovered decideRunStep
  // re-running from scratch) must not start a second work order or re-bump
  // past what a fresh ask would produce.
  const replay = await new PostgresRunRecordRepository(sql!).decide_run(runId, now);
  expect(replay.ok && replay.value.kind).toBe("wait");
  const stillOne = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1)", [unit.workOrderId]);
  expect(stillOne[0]?.count).toBe("1");
});

test("crash matrix: ensure-executor-attachment and attach-external each commit once under replay", async () => {
  const unit = await freshUnit();
  if (!unit) return skip();
  const { records, workOrderId, now } = unit;
  // A crash between the attachment insert and the external attach is exactly
  // two independent calls, each idempotent on its own.
  await records.ensure_executor_attachment(workOrderId, "crash-matrix-executor", now);
  await records.ensure_executor_attachment(workOrderId, "crash-matrix-executor", now);
  await records.attach_external(workOrderId, { kind: "kbbl_session", session_id: "session-recovered" }, now);
  await records.attach_external(workOrderId, { kind: "kbbl_session", session_id: "session-recovered" }, now);
  const rows = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]);
  expect(rows[0]?.count).toBe("1");
  const attachment = await records.ensure_executor_attachment(workOrderId, "crash-matrix-executor", now);
  expect(attachment.external_reference).toEqual({ kind: "kbbl_session", session_id: "session-recovered" });
});

test("crash matrix: observe-executor recorded twice for the same terminal fact stays one health row", async () => {
  const unit = await freshUnit();
  if (!unit) return skip();
  const { records, workOrderId, now } = unit;
  await records.ensure_executor_attachment(workOrderId, "crash-matrix-executor", now);
  await records.observe_executor(workOrderId, { kind: "ended_succeeded", metadata: { attempt: 1 }, observed_at: now }, now);
  // A recovered observeExecutorStep re-observes and re-records — the row is
  // replaced with the same fact, not duplicated into a second row.
  await records.observe_executor(workOrderId, { kind: "ended_succeeded", metadata: { attempt: 1 }, observed_at: now }, now);
  const rows = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]);
  expect(rows[0]?.count).toBe("1");
});

test("crash matrix: duplicate immediate publication with the same idempotency key commits once", async () => {
  const unit = await freshUnit();
  if (!unit) return skip();
  const { records, runId, workOrderId, capabilityHash, now } = unit;
  await records.decide_run(runId, now);
  const body = { done: true };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const artifactId = randomUUID() as ArtifactId;
  const first = await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body, capability_hash: capabilityHash, idempotency_key: "crash-replay", payload_hash: payloadHash, published_at: now });
  expect(first.kind).toBe("published");
  // The caller could not tell whether the commit landed before the crash, so
  // it retries the identical PUT. A second artifact id in the retried body is
  // exactly what an HTTP client generates fresh on retry — the repository's
  // idempotency key, not the caller-chosen id, is what must converge.
  const retry = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body, capability_hash: capabilityHash, idempotency_key: "crash-replay", payload_hash: payloadHash, published_at: now });
  expect(retry).toEqual(expect.objectContaining({ kind: "already_applied", artifact_id: artifactId }));
  const rows = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.artifact WHERE work_order_id = $1 AND output_name = 'result'", [workOrderId]);
  expect(rows[0]?.count).toBe("1");
});

test("crash matrix: gated publication replayed before and after the wait opens commits one slot and one wait", async () => {
  const unit = await freshUnit();
  if (!sql) return skip();
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`gate-secret-${workOrderId}`).digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `crash-matrix-gate-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: "crash-matrix-executor",
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true,
      release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" } }],
    created_at: now,
  });
  await records.decide_run(runId, now);
  const body = { plan: "draft" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const first = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body, capability_hash: capabilityHash, idempotency_key: "crash-gate-replay", payload_hash: payloadHash, published_at: now });
  if (first.kind !== "pending") throw new Error(`expected pending, got ${first.kind}`);
  const retry = await new PostgresRunRecordRepository(sql).publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body, capability_hash: capabilityHash, idempotency_key: "crash-gate-replay", payload_hash: payloadHash, published_at: now });
  expect(retry).toEqual(expect.objectContaining({ kind: "already_applied", artifact_id: first.artifact_id }));
  const waits = await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.wait WHERE run_unit_id = $1", [runUnitId]);
  expect(waits[0]?.count).toBe("1");
  const slots = await sql.query<{ readonly state: string }>("SELECT state FROM oakridge.run_output_slot WHERE run_unit_id = $1", [runUnitId]);
  expect(slots[0]?.state).toBe("pending");

  // Now cross the gate-close boundary the same way: replaying the same
  // release decision after a crash absorbs rather than double-releasing.
  const closedOnce = await records.close_output_wait({ wait_id: first.wait_id, disposition: "release", actor: "operator:sam", detail: null, decided_at: now });
  expect(closedOnce.kind).toBe("released");
  const closedAgain = await new PostgresRunRecordRepository(sql).close_output_wait({ wait_id: first.wait_id, disposition: "release", actor: "operator:sam", detail: null, decided_at: now });
  expect(closedAgain.kind).toBe("already_applied");
  const released = await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND state = 'released'", [runUnitId]);
  expect(released[0]?.count).toBe("1");
  void unit;
});

test("crash matrix: handoff-external close replayed after a crash absorbs rather than re-releasing", async () => {
  if (!sql) return skip();
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`handoff-secret-${workOrderId}`).digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `crash-matrix-handoff-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: "crash-matrix-executor",
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "build_result", artifact_type: "dev.build_result", required: true,
      release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }],
    created_at: now,
  });
  await records.decide_run(runId, now);
  const body = { pr_url: "https://example.invalid/pr/1" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "build_result", body, capability_hash: capabilityHash, idempotency_key: "handoff-1", payload_hash: payloadHash, published_at: now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);
  const first = await records.close_output_wait({ wait_id: published.wait_id, disposition: "release", actor: "poller:github", detail: "pr-42-merged", decided_at: now });
  expect(first.kind).toBe("released");
  const replay = await new PostgresRunRecordRepository(sql).close_output_wait({ wait_id: published.wait_id, disposition: "release", actor: "poller:github", detail: "pr-42-merged", decided_at: now });
  expect(replay.kind).toBe("already_applied");
  expect(await decideUntilSettled(records, runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
});

// ---------------------------------------------------------------------------
// Duplicate start of the same work-order workflow: recovering the same
// identity must reuse the one row rather than create a second.
// ---------------------------------------------------------------------------

test("crash matrix: duplicate start of the same work-order workflow id reuses the one work order", async () => {
  const unit = await freshUnit();
  if (!unit) return skip();
  const { runId } = unit;
  const decision = await unit.records.decide_run(runId, unit.now);
  if (!decision.ok || decision.value.kind !== "recheck") throw new Error("expected recheck");
  const workOrderIds = new Set(decision.value.started.map((order) => order.id));
  // A second decide (the recovered root re-asking after its own crash) must
  // select the same, already-started work order rather than mint another.
  const second = await new PostgresRunRecordRepository(sql!).decide_run(runId, unit.now);
  expect(second.ok && second.value.kind).toBe("wait");
  const rows = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = ANY($1::uuid[]))", [[...workOrderIds]]);
  expect(rows[0]?.count).toBe("1");
});

// ---------------------------------------------------------------------------
// One real DBOS proof: recovering a work order after a restart uses the same
// workflow id, per spec §3.5 ("Starting or recovering the same work order uses
// the same workflow ID"). DBOS itself guarantees that starting an id twice
// replays the first invocation's outcome rather than re-running the function
// body — this is what a supervisor restarting the process and, not knowing an
// earlier attempt already finished, calling start again actually relies on.
//
// A literal killed-process crash — interrupting a step or a durable sleep by
// force rather than by the workflow returning — cannot be simulated
// in-process: `DBOS.shutdown()` drains every registered workflow to its own
// natural completion first, and `oakridgeV2WorkOrderWorkflow` is designed to
// keep observing until its executor reports terminal, so it never reaches
// one on command. `run-record-process-crash.test.ts` covers that boundary
// with a real OS-process kill/restart harness instead.
// ---------------------------------------------------------------------------

const DBOS_APP_NAME = "oakridge-crash-matrix";

test("crash matrix: starting the same work-order workflow id twice never re-attaches its external session", async () => {
  if (!sql || !databaseUrl) return skip();
  const unit = await freshUnit("crash-matrix-real-dbos");
  if (!unit) return skip();

  let startCalls = 0;
  const adapter: ExecutorAdapter = {
    executor_type: "crash-matrix-real-dbos",
    async start_or_attach(_request: ExecutionRequest, _operation_id): Promise<ExternalExecutionReference> {
      startCalls += 1;
      return { kind: "kbbl_session", session_id: "crash-matrix-session" };
    },
    // Reports terminal immediately: this test proves DBOS's own duplicate-id
    // guarantee, not the observe loop, so nothing here needs to keep running.
    async observe_terminal(): Promise<ExecutorObservationAttempt> {
      return { kind: "terminal", observation: { kind: "succeeded", metadata: {} } };
    },
    async deliver_input() {},
    async cancel_or_fence() {},
  };

  const applicationVersion = `crash-matrix-${randomUUID()}`;
  DBOS.setConfig({ name: DBOS_APP_NAME, systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });
  registerRunRecordWorkflowServices({ records: unit.records, find_executor: () => adapter, now: () => new Date().toISOString() });
  await DBOS.launch();
  try {
    await DBOS.startWorkflow(runRecordWorkOrderWorkflow, { workflowID: unit.workOrderWorkflowId })(unit.workOrderId);
    await awaitCondition("the work order's cleanup workflow to finish", async () => {
      const rows = await sql!.query<{ readonly cleanup_state: string }>("SELECT cleanup_state FROM oakridge.executor_attachment WHERE work_order_id = $1", [unit.workOrderId]);
      return rows[0]?.cleanup_state === "complete" ? true : null;
    }, 10_000);
    expect(startCalls).toBe(1);

    // A restarted process re-invoking the same work order id — believing it
    // needs to start work it does not know already finished — must not
    // re-attach a second external session for it.
    await DBOS.startWorkflow(runRecordWorkOrderWorkflow, { workflowID: unit.workOrderWorkflowId })(unit.workOrderId);
    expect(startCalls).toBe(1);
    const attachments = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [unit.workOrderId]);
    expect(attachments[0]?.count).toBe("1");
  } finally {
    await DBOS.shutdown();
  }
}, 20_000);

test("crash matrix: starting the same run workflow id twice never starts a second work order", async () => {
  if (!sql || !databaseUrl) return skip();
  const unit = await freshUnit("crash-matrix-real-dbos-root");
  if (!unit) return skip();

  let startCalls = 0;
  const adapter: ExecutorAdapter = {
    executor_type: "crash-matrix-real-dbos-root",
    async start_or_attach(_request: ExecutionRequest, _operation_id): Promise<ExternalExecutionReference> {
      startCalls += 1;
      return { kind: "kbbl_session", session_id: "crash-matrix-root-session" };
    },
    async observe_terminal(): Promise<ExecutorObservationAttempt> {
      return { kind: "terminal", observation: { kind: "succeeded", metadata: {} } };
    },
    async deliver_input() {},
    async cancel_or_fence() {},
  };

  const applicationVersion = `crash-matrix-root-${randomUUID()}`;
  DBOS.setConfig({ name: DBOS_APP_NAME, systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });
  registerRunRecordWorkflowServices({ records: unit.records, find_executor: () => adapter, now: () => new Date().toISOString() });
  await DBOS.launch();
  try {
    // The agent publishes its result out of band, over the HTTP emit route in
    // production. Publishing before the root ever asks means its very first
    // `decide_run` already sees the released slot and completes immediately —
    // this test is about the root's own duplicate-id safety, not the ask loop.
    const body = { done: true };
    const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await unit.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: unit.workOrderId, output_name: "result",
      body, capability_hash: unit.capabilityHash, idempotency_key: "crash-matrix-root-result", payload_hash: payloadHash, published_at: unit.now });

    await DBOS.startWorkflow(runRecordWorkflow, { workflowID: unit.runId })(unit.runId);
    await awaitCondition("the run to reach a terminal state", async () => {
      const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [unit.runId]);
      return rows[0]?.state === "succeeded" ? true : null;
    }, 10_000);

    // A restarted process asking the same run id again — believing the run
    // might still need work started — must not mint a second work order.
    await DBOS.startWorkflow(runRecordWorkflow, { workflowID: unit.runId })(unit.runId);
    expect(startCalls).toBe(0); // the required slot was already released before the root ever ran; no work order was ever started.
    const orders = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE id = $1", [unit.workOrderId]);
    expect(orders[0]?.count).toBe("1");
  } finally {
    await DBOS.shutdown();
  }
}, 20_000);
