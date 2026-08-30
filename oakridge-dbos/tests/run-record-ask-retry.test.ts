/**
 * Spec §3.5 / §5.4: the operational-failure boundary. Built on
 * `run-record-wake-hints.test.ts`'s fixture (copied rather than imported —
 * that file's module-level DBOS config would collide with this one's in the
 * same `bun test` process), but the repository is constructed over a
 * `FaultInjectingSqlExecutor` so `decide_run`'s own transaction can be made
 * to fail on demand.
 *
 * (a) proves a blip within the step's own retry budget (`maxAttempts: 5`) is
 * absorbed in place — one recorded step execution per successful ask, not
 * one per retry, and no wake sent beyond the one this test sends.
 * (b) proves an outage that outlasts the step's budget does not end the
 * workflow: the root stays `PENDING`, the run stays `active`, nothing is
 * written, and once the injector clears the run completes on its own — no
 * wake, no operator action (spec §3.5's `RUN_RECORD_ASK_FAILURE_BACKOFF_SECONDS`
 * sleep-and-retry).
 */
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../src/domain/execution";
import type { ArtifactId, InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { runRecordWorkflowId } from "../src/domain/workflow-ids";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { RUN_RECORD_WAKE_TOPIC, registerRunRecordWorkflowServices, runRecordWorkflow } from "../src/workflows/run-record-topology";
import { awaitCondition } from "./support/dev-flow-harness";
import { findTestDatabaseUrl } from "./support/durable-database";
import { FaultInjectingSqlExecutor } from "./support/fault-injecting-sql";

/** Never through `registerDbosTransportClient` — see run-record-wake-hints.test.ts's own note on that registry. */
const sendWake = (client: DBOSClient, run_id: WorkflowRunId, idempotency_key: string): Promise<void> =>
  client.send(runRecordWorkflowId(run_id), {}, RUN_RECORD_WAKE_TOPIC, idempotency_key);

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

const skip = (): void => console.warn("run-record ask-retry test SKIPPED: no PostgreSQL reachable");

const immediateAdapter = (executorType: string): ExecutorAdapter => ({
  executor_type: executorType,
  async start_or_attach(_request: ExecutionRequest, _operation_id): Promise<ExternalExecutionReference> { return { kind: "kbbl_session", session_id: "ask-retry-session" }; },
  async observe_terminal(): Promise<ExecutorObservationAttempt> { return { kind: "terminal", observation: { kind: "succeeded", metadata: {} } }; },
  async deliver_input() {},
  async cancel_or_fence() {},
});

interface ParkedRunFixture {
  readonly records: PostgresRunRecordRepository;
  readonly runId: WorkflowRunId;
  readonly workOrderId: WorkOrderId;
  readonly capabilityHash: string;
  readonly injector: FaultInjectingSqlExecutor;
  readonly dbosClient: DBOSClient;
  stop(): Promise<void>;
}

const decideRunStepExecutionCount = async (runId: WorkflowRunId): Promise<number> => {
  const rows = await sql!.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'oakridgeV2DecideRunStep' AND completed_at_epoch_ms IS NOT NULL",
    [runRecordWorkflowId(runId)]);
  return Number(rows[0]?.count ?? 0);
};

const transitionCount = async (runId: WorkflowRunId): Promise<number> => {
  const rows = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_transition WHERE run_id = $1", [runId]);
  return Number(rows[0]?.count ?? 0);
};

const recordVersion = async (runId: WorkflowRunId): Promise<number> => {
  const rows = await sql!.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id = $1", [runId]);
  return Number(rows[0]?.record_version ?? 0);
};

/**
 * One straight-through run with a single immediate-release, unpublished
 * unit — copied from `run-record-wake-hints.test.ts`'s `setupParkedRun`, with
 * the one change spec §5.4 calls for: the repository is constructed over a
 * `FaultInjectingSqlExecutor(sql)` rather than `sql` directly, unarmed until
 * the test arms it. A real DBOS runtime is launched and its root workflow
 * started, parked in `DBOS.recv` by the time this resolves.
 */
const setupParkedRun = async (label: string): Promise<ParkedRunFixture | null> => {
  if (!sql || !databaseUrl) return null;
  const executorType = `ask-retry-${label}`;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`ask-retry-${workOrderId}`).digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `ask-retry-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);

  // Unarmed until the test calls `fail_next_transactions`, so bootstrap and
  // the root's own early asks pass straight through to `sql`.
  const injector = new FaultInjectingSqlExecutor(sql);
  const records = new PostgresRunRecordRepository(injector);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: executorType,
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    created_at: now,
  });

  const applicationVersion = `ask-retry-${label}-${randomUUID()}`;
  DBOS.setConfig({ name: "oakridge-ask-retry", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });
  registerRunRecordWorkflowServices({ records, find_executor: () => immediateAdapter(executorType), now: () => new Date().toISOString() });
  const dbosClient = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
  await DBOS.launch();

  await DBOS.startWorkflow(runRecordWorkflow, { workflowID: runRecordWorkflowId(runId) })(runId);
  await awaitCondition("the work order to start", async () => {
    const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [workOrderId]);
    return rows[0]?.state === "started" ? true : null;
  }, 10_000);
  // The root's second decideRunStep (its "wait" decision) having completed is
  // what puts it in `DBOS.recv` — see run-record-wake-hints.test.ts for why
  // this, rather than the work order row, is what a fast test must wait on.
  await awaitCondition("the root's second decideRunStep (its wait decision) to complete", async () =>
    (await decideRunStepExecutionCount(runId)) >= 2 ? true : null, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    records, runId, workOrderId, capabilityHash, injector, dbosClient,
    async stop() { await DBOS.shutdown(); await dbosClient.destroy(); },
  };
};

const publish = async (fixture: ParkedRunFixture, idempotencyKey: string): Promise<void> => {
  const body = { done: true };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const result = await fixture.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: fixture.workOrderId, output_name: "result",
    body, capability_hash: fixture.capabilityHash, idempotency_key: idempotencyKey, payload_hash: payloadHash, published_at: new Date().toISOString() });
  if (result.kind !== "published") throw new Error(`expected published, got ${result.kind}`);
};

const runSucceeded = async (fixture: ParkedRunFixture, timeoutMs: number): Promise<void> => {
  await awaitCondition("the run to succeed", async () => {
    const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [fixture.runId]);
    return rows[0]?.state === "succeeded" ? true : null;
  }, timeoutMs);
};

test("(a) a blip within the step's retry budget is absorbed, not re-asked", async () => {
  const fixture = await setupParkedRun("blip");
  if (!fixture) return skip();
  try {
    // Publication goes through the same (still-unarmed) repository, before
    // the injector is armed — the fact this test wants absorbed, not the
    // publish call itself.
    await publish(fixture, "blip-publish-1");

    const stepsBefore = await decideRunStepExecutionCount(fixture.runId);
    const transitionsBefore = await transitionCount(fixture.runId);
    const versionBefore = await recordVersion(fixture.runId);

    fixture.injector.fail_next_transactions(2);
    await sendWake(fixture.dbosClient, fixture.runId, "blip-wake-1");

    await runSucceeded(fixture, 15_000);

    expect(fixture.injector.failures_injected).toBe(2);
    const stepsAfter = await decideRunStepExecutionCount(fixture.runId);
    // Three asks succeed after the wake: the fact (satisfied) -> recheck,
    // the stage closing (succeeded) -> recheck, the run completing. The two
    // failed attempts inside the first of those retried in place and left no
    // row of their own.
    expect(stepsAfter - stepsBefore).toBe(3);
    expect(await transitionCount(fixture.runId) - transitionsBefore).toBe(1); // only "unit_satisfied" writes a transition row; stage-succeeded and complete do not
    expect(await recordVersion(fixture.runId) - versionBefore).toBe(3); // one increment per successful ask
  } finally {
    await fixture.stop();
  }
}, 30_000);

test("(b) an outage that outlasts the step's retry budget never ends the workflow", async () => {
  const fixture = await setupParkedRun("outage");
  if (!fixture) return skip();
  try {
    await publish(fixture, "outage-publish-1");

    const transitionsBefore = await transitionCount(fixture.runId);
    fixture.injector.fail_next_transactions(8); // > maxAttempts (5): the step exhausts its budget and throws into the workflow once
    await sendWake(fixture.dbosClient, fixture.runId, "outage-wake-1");

    // While the step is retrying (and after it exhausts and the root is
    // sleeping through RUN_RECORD_ASK_FAILURE_BACKOFF_SECONDS), the record
    // must stay untouched and the root must stay PENDING, not terminate.
    const pollDeadline = Date.now() + 10_000;
    let polls = 0;
    while (Date.now() < pollDeadline) {
      const statusRows = await sql!.query<{ readonly status: string }>("SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1", [runRecordWorkflowId(fixture.runId)]);
      const runRows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [fixture.runId]);
      const transitions = await transitionCount(fixture.runId);
      if (polls % 4 === 0) console.log(`ask-retry outage t+${Math.round((Date.now() - (pollDeadline - 10_000)) / 100) / 10}s: root status=${statusRows[0]?.status} run state=${runRows[0]?.state} transitions=${transitions} failures_injected=${fixture.injector.failures_injected}`);
      expect(statusRows[0]?.status).toBe("PENDING");
      expect(runRows[0]?.state).toBe("active");
      expect(transitions).toBe(transitionsBefore);
      polls += 1;
      await Bun.sleep(500);
    }

    // No wake, no operator action: the root's own catch-log-sleep-retry loop
    // (spec §3.5) is what gets it there once the injector clears itself.
    await runSucceeded(fixture, 120_000);
    expect(fixture.injector.failures_injected).toBe(8);
    console.log(`ask-retry outage: run ${fixture.runId} succeeded after the injector cleared, record_version=${await recordVersion(fixture.runId)}`);
  } finally {
    await fixture.stop();
  }
}, 150_000);
