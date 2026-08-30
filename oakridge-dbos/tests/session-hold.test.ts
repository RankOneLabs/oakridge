import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";

import { createDomainReadApp } from "../src/http/domain-reads";
import type { SessionHold } from "../src/domain/session-hold";
import type { SessionHoldRepository } from "../src/storage/repositories";
import type { InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";
import { ensureDbosSystemSchema } from "./support/dbos-system-schema";

const hold: SessionHold = {
  session_id: "session-1", execution_id: "stage-1:0" as SessionHold["execution_id"],
  execution_workflow_id: "root:stage:plan_writer:unit:0", run_id: "run-1" as SessionHold["run_id"],
  stage_instance_id: "stage-1" as SessionHold["stage_instance_id"], stage_key: "plan_writer",
  unit_id: "0" as SessionHold["unit_id"],
};

const appWith = (session_holds: SessionHoldRepository) => new Hono().route("/", createDomainReadApp({
  stages: {} as never, artifacts: {} as never, session_holds,
}));

test("a session a live execution still needs is reported as held", async () => {
  const response = await appWith({ async find_session_hold() { return hold; } }).request("/session_holds/session-1");
  expect(await response.json()).toEqual({ held: true, hold });
});

test("a session nothing depends on is reported free", async () => {
  const response = await appWith({ async find_session_hold() { return null; } }).request("/session_holds/session-1");
  expect(await response.json()).toEqual({ held: false, hold: null });
});

/**
 * Session ids are kbbl's, not uuid-shaped domain ids, so the route must pass
 * them through as given rather than rejecting them the way run ids are.
 */
test("a session id is passed through without uuid validation", async () => {
  let asked = "";
  const response = await appWith({ async find_session_hold(id) { asked = id; return null; } }).request("/session_holds/not-a-uuid");
  expect(response.status).toBe(200);
  expect(asked).toBe("not-a-uuid");
});

// --- PostgresOperatorProjectionRepository.find_session_hold, against real Postgres ---

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
if (sql && databaseUrl) await ensureDbosSystemSchema(databaseUrl);
afterAll(async () => { await sql?.close(); });

const EXECUTOR_VERSION = "v2";

interface SeededWorkOrder {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly work_order_id: WorkOrderId;
  readonly workflow_id: string;
  readonly unit_id: UnitId;
}

/**
 * A run-unit and work order created through the real repository (so the row
 * shapes match production), then nudged with raw SQL into whatever
 * work-order state, DBOS status, and application version a case needs —
 * `initialize_straight_through` only ever creates `available` work orders,
 * and nothing in this suite drives `decide_run` through a real compiled
 * definition just to reach `started`.
 */
const seedWorkOrder = async (
  sqlExecutor: PgPostgresExecutor,
  options: {
    readonly work_state: "available" | "started" | "completed" | "abandoned";
    readonly attach_session_id: string | null;
    readonly dbos_status: "PENDING" | "SUCCESS" | null;
    readonly dbos_application_version: string | null;
  },
): Promise<SeededWorkOrder> => {
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const unitId = "unit-1" as UnitId;
  const workflowId = `v2-work:${workOrderId}`;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(workOrderId).digest("hex");
  await sqlExecutor.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at)
    VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `session-hold-${runId}`, now]);
  await sqlExecutor.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at)
    VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sqlExecutor);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: unitId,
    work_order_id: workOrderId, work_order_workflow_id: workflowId, stage_key: "review", executor_type: "delegated_session",
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }], created_at: now,
  });
  if (options.work_state !== "available") {
    // `completed`/`abandoned` require a non-null `completed_at` (work_order_check).
    const completedAt = options.work_state === "started" ? null : now;
    await sqlExecutor.query("UPDATE oakridge.work_order SET state = $2, completed_at = $3::timestamptz WHERE id = $1", [workOrderId, options.work_state, completedAt]);
  }
  if (options.attach_session_id !== null) {
    await records.ensure_executor_attachment(workOrderId, "delegated_session", now);
    await records.attach_external(workOrderId, { kind: "kbbl_session", session_id: options.attach_session_id }, now);
  }
  if (options.dbos_status !== null) {
    await sqlExecutor.query(`INSERT INTO dbos.workflow_status (workflow_uuid, status, name, application_version, executor_id, created_at, updated_at)
      VALUES ($1,$2,'oakridgeV2WorkOrderWorkflow',$3,'test-executor',(extract(epoch FROM now())*1000)::bigint,(extract(epoch FROM now())*1000)::bigint)`,
      [workflowId, options.dbos_status, options.dbos_application_version]);
  }
  return { run_id: runId, stage_instance_id: stageId, work_order_id: workOrderId, workflow_id: workflowId, unit_id: unitId };
};

test("a started work order's attachment holds its session while the workflow is PENDING under this application version", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const sessionId = `session-${randomUUID()}`;
  const seeded = await seedWorkOrder(sql, { work_state: "started", attach_session_id: sessionId, dbos_status: "PENDING", dbos_application_version: EXECUTOR_VERSION });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(sessionId)).toEqual({
    session_id: sessionId, execution_id: seeded.work_order_id as unknown as SessionHold["execution_id"],
    execution_workflow_id: seeded.workflow_id, run_id: seeded.run_id, stage_instance_id: seeded.stage_instance_id,
    stage_key: "review", unit_id: seeded.unit_id,
  });
});

test("a completed work order holds nothing", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const sessionId = `session-${randomUUID()}`;
  await seedWorkOrder(sql, { work_state: "completed", attach_session_id: sessionId, dbos_status: "PENDING", dbos_application_version: EXECUTOR_VERSION });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(sessionId)).toBeNull();
});

test("a workflow that is not PENDING holds nothing", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const sessionId = `session-${randomUUID()}`;
  await seedWorkOrder(sql, { work_state: "started", attach_session_id: sessionId, dbos_status: "SUCCESS", dbos_application_version: EXECUTOR_VERSION });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(sessionId)).toBeNull();
});

/**
 * DBOS recovers a workflow only when its application_version matches this
 * executor's, so one left PENDING by an earlier version never resumes and
 * never terminalizes. Read as a live hold it would make the session
 * permanently unclosable — a claim no run would ever release.
 */
test("a workflow PENDING under another application version holds nothing", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const sessionId = `session-${randomUUID()}`;
  await seedWorkOrder(sql, { work_state: "started", attach_session_id: sessionId, dbos_status: "PENDING", dbos_application_version: "v1-stranded" });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(sessionId)).toBeNull();
});

/** Rows written before workflows carried a version are not evidence of abandonment, so they keep the guard rather than losing it. */
test("a workflow with no recorded application version still holds", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const sessionId = `session-${randomUUID()}`;
  const seeded = await seedWorkOrder(sql, { work_state: "started", attach_session_id: sessionId, dbos_status: "PENDING", dbos_application_version: null });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(sessionId)).toEqual(expect.objectContaining({ session_id: sessionId, execution_workflow_id: seeded.workflow_id }));
});

test("a session no attachment names holds nothing", async () => {
  if (!sql) { console.warn("session hold PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  await seedWorkOrder(sql, { work_state: "started", attach_session_id: null, dbos_status: "PENDING", dbos_application_version: EXECUTOR_VERSION });
  const repository = new PostgresOperatorProjectionRepository(sql, EXECUTOR_VERSION);
  expect(await repository.find_session_hold(`session-${randomUUID()}`)).toBeNull();
});
