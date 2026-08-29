/**
 * `oakridgeV2RunWorkflow`'s wait boundary parks in `DBOS.recv` on
 * `RUN_RECORD_WAKE_TOPIC` rather than a bare sleep. The topic exists purely to
 * shorten latency: every test here proves the root converges to the correct
 * outcome regardless of whether a wake arrives at all, arrives more than
 * once, or arrives before the fact it would have signaled even exists —
 * because `DBOS.recv` timing out is exactly as valid an unblock as a message,
 * and either way the very next line re-reads the authoritative record.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../src/domain/execution";
import type { ArtifactId, InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { RUN_RECORD_WAKE_TIMEOUT_SECONDS, RUN_RECORD_WAKE_TOPIC, registerRunRecordWorkflowServices, runRecordWorkflow } from "../src/workflows/run-record-topology";
import { awaitCondition } from "./support/dev-flow-harness";
import { findTestDatabaseUrl } from "./support/durable-database";

/**
 * Sends directly on this test's own `DBOSClient`, never through
 * `registerDbosTransportClient` — that registry is one module-level
 * singleton shared by every test file in the same `bun test` process, and
 * this file's client is destroyed at the end of each test. Registering it
 * there would leave the global pointing at a dead client for whichever test
 * file happens to run next.
 */
const sendWake = (client: DBOSClient, run_id: string, idempotency_key: string): Promise<void> =>
  client.send(run_id, {}, RUN_RECORD_WAKE_TOPIC, idempotency_key);

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

const skip = (): void => console.warn("run-record wake-hint test SKIPPED: no PostgreSQL reachable");

const immediateAdapter = (executorType: string): ExecutorAdapter => ({
  executor_type: executorType,
  async start_or_attach(_request: ExecutionRequest, _operation_id): Promise<ExternalExecutionReference> { return { kind: "kbbl_session", session_id: "wake-hint-session" }; },
  async observe_terminal(): Promise<ExecutorObservationAttempt> { return { kind: "terminal", observation: { kind: "succeeded", metadata: {} } }; },
  async deliver_input() {},
  async cancel_or_fence() {},
});

interface WakeHintFixture {
  readonly records: PostgresRunRecordRepository;
  readonly runId: WorkflowRunId;
  readonly workOrderId: WorkOrderId;
  readonly capabilityHash: string;
  readonly now: string;
  readonly dbosClient: DBOSClient;
  stop(): Promise<void>;
}

/**
 * One straight-through run with a single immediate-release, unpublished
 * unit, with a real DBOS runtime launched and its root workflow started —
 * parked in `DBOS.recv` by the time this resolves, waiting on the run's
 * required slot the way it would be in production before an agent emits.
 */
const setupParkedRun = async (label: string): Promise<WakeHintFixture | null> => {
  if (!sql || !databaseUrl) return null;
  const executorType = `wake-hint-${label}`;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`wake-hint-${workOrderId}`).digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{}'::jsonb,false,$3::timestamptz)`, [definitionId, `wake-hint-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: executorType,
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    created_at: now,
  });

  const applicationVersion = `wake-hint-${label}-${randomUUID()}`;
  DBOS.setConfig({ name: "oakridge-wake-hints", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });
  registerRunRecordWorkflowServices({ records, find_executor: () => immediateAdapter(executorType), now: () => new Date().toISOString() });
  const dbosClient = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
  await DBOS.launch();

  await DBOS.startWorkflow(runRecordWorkflow, { workflowID: runId })(runId);
  // The work order reaching 'started' is the root having already run its one
  // start_work iteration and looped back into decide_run — from here its next
  // "wait" decision parks it in `DBOS.recv`, which is the boundary these
  // tests are about.
  await awaitCondition("the work order to start", async () => {
    const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [workOrderId]);
    return rows[0]?.state === "started" ? true : null;
  }, 10_000);
  // The root's first decideRunStep call is the one that returned start_work;
  // its second is the "wait" decision that leads straight into `DBOS.recv`.
  // Waiting for that second step to have actually completed — not just for
  // the work order row it wrote — is what keeps a fast test process from
  // racing ahead of the root and publishing before it ever reaches `recv`.
  await awaitCondition("the root's second decideRunStep (its wait decision) to complete", async () => {
    const rows = await sql!.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'oakridgeV2DecideRunStep' AND completed_at_epoch_ms IS NOT NULL",
      [runId]);
    return Number(rows[0]?.count ?? 0) >= 2 ? true : null;
  }, 10_000);
  // `DBOS.recv` is called on the very next line after that step returns —
  // a fixed grace period is simpler and just as reliable as instrumenting
  // that exact call, given everything above already executes in milliseconds.
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    records, runId, workOrderId, capabilityHash, now, dbosClient,
    async stop() { await DBOS.shutdown(); await dbosClient.destroy(); },
  };
};

const publish = async (fixture: WakeHintFixture, idempotencyKey: string): Promise<void> => {
  const body = { done: true };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const result = await fixture.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: fixture.workOrderId, output_name: "result",
    body, capability_hash: fixture.capabilityHash, idempotency_key: idempotencyKey, payload_hash: payloadHash, published_at: new Date().toISOString() });
  if (result.kind !== "published") throw new Error(`expected published, got ${result.kind}`);
};

const runSucceeded = async (fixture: WakeHintFixture, timeoutMs: number): Promise<void> => {
  await awaitCondition("the run to succeed", async () => {
    const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [fixture.runId]);
    return rows[0]?.state === "succeeded" ? true : null;
  }, timeoutMs);
};

test("a wake hint that is never sent still converges through the bounded recheck alone", async () => {
  const fixture = await setupParkedRun("lost");
  if (!fixture) return skip();
  try {
    // No send at all — the root can only advance once `DBOS.recv` times out
    // on its own and decideRunStep runs again on a bounded schedule.
    await publish(fixture, "wake-hint-lost-1");
    await runSucceeded(fixture, (RUN_RECORD_WAKE_TIMEOUT_SECONDS + 10) * 1000);
  } finally {
    await fixture.stop();
  }
}, (RUN_RECORD_WAKE_TIMEOUT_SECONDS + 15) * 1000);

test("duplicated wake hints do not change the outcome or double-apply anything", async () => {
  const fixture = await setupParkedRun("duplicate");
  if (!fixture) return skip();
  try {
    await publish(fixture, "wake-hint-duplicate-1");
    // The same idempotency key sent twice is deduped by DBOS's own send
    // idempotency; different keys for the same fact are not deduped there,
    // so this also proves duplicate *processing* is harmless on its own.
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-duplicate-send-1");
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-duplicate-send-1");
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-duplicate-send-2");
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-duplicate-send-3");
    await runSucceeded(fixture, 5_000);

    // Nothing about the duplicate deliveries multiplied the committed effect:
    // one artifact, one work order, and the run's own single completion
    // transition (no repeated "start_work" or spurious extra rows).
    const artifacts = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.artifact WHERE work_order_id = $1", [fixture.workOrderId]);
    expect(artifacts[0]?.count).toBe("1");
    const orders = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1)", [fixture.workOrderId]);
    expect(orders[0]?.count).toBe("1");
  } finally {
    await fixture.stop();
  }
}, 20_000);

test("a wake hint sent before the fact it would signal still converges once the fact commits", async () => {
  const fixture = await setupParkedRun("reordered");
  if (!fixture) return skip();
  try {
    // Sent while the required slot is still empty: the root wakes, asks, and
    // correctly finds nothing has changed — this must not be mistaken for
    // "checked, nothing to do, stop checking".
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-reordered-early");
    // Proof the early wake was actually consumed and the root re-parked,
    // rather than assuming a fixed delay was enough: a third decideRunStep
    // call only happens after the recv this wake unblocked returns.
    await awaitCondition("the root to process the premature wake and re-park", async () => {
      const rows = await sql!.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'oakridgeV2DecideRunStep' AND completed_at_epoch_ms IS NOT NULL",
        [fixture.runId]);
      return Number(rows[0]?.count ?? 0) >= 3 ? true : null;
    }, 5_000);

    await publish(fixture, "wake-hint-reordered-1");
    // A second, correctly-timed hint now carries the fact.
    await sendWake(fixture.dbosClient, fixture.runId, "wake-hint-reordered-late");
    await runSucceeded(fixture, 5_000);
  } finally {
    await fixture.stop();
  }
}, 20_000);
