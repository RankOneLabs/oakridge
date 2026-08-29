import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import type { ArtifactId, InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

test("one released run-owned slot completes a straight-through run after repository restart", async () => {
  if (!sql) {
    console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable");
    return;
  }
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const artifactId = randomUUID() as ArtifactId;
  const unitId = "unit-1" as UnitId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update("work-secret").digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at)
    VALUES ($1,$2,1,'{}'::jsonb,false,$3::timestamptz)`, [definitionId, `v2-test-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at)
    VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);

  const records = new PostgresRunRecordRepository(sql);
  const initialization = { run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: unitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: "delegated_session",
    work_order_capability_hash: capabilityHash,
    resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true }], created_at: now } as const;
  await records.initialize_straight_through(initialization);
  await records.initialize_straight_through(initialization);
  expect((await sql.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id = $1", [runId]))[0]?.record_version).toBe("1");
  expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.workflow_attempt WHERE run_id = $1", [runId]))[0]?.count).toBe("0");
  await expect(records.initialize_straight_through({ ...initialization, work_order_workflow_id: "conflicting-workflow" }))
    .rejects.toThrow("conflicts with its stored initialization");

  const concurrentDecisions = await Promise.all([records.decide_run(runId, now), new PostgresRunRecordRepository(sql).decide_run(runId, now)]);
  expect(concurrentDecisions.filter((decision) => decision.ok && decision.value.kind === "start_work")).toHaveLength(1);
  expect(concurrentDecisions.filter((decision) => decision.ok && decision.value.kind === "wait")).toHaveLength(1);
  await records.ensure_executor_attachment(workOrderId, "delegated_session", now);
  await records.attach_external(workOrderId, { kind: "kbbl_session", session_id: "session-1" }, now);
  const recoveredRecords = new PostgresRunRecordRepository(sql);
  expect(await recoveredRecords.ensure_executor_attachment(workOrderId, "delegated_session", now)).toEqual(expect.objectContaining({
    work_order_id: workOrderId, external_reference: { kind: "kbbl_session", session_id: "session-1" },
  }));
  expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]))[0]?.count).toBe("1");
  const body = { complete: true };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  expect(await records.publish_immediate({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: "not-the-capability", idempotency_key: "unauthorized", payload_hash: payloadHash, published_at: now }))
    .toEqual({ kind: "invalid_capability", detail: "work-order capability was not accepted" });
  expect(await records.publish_immediate({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "result-1", payload_hash: payloadHash, published_at: now })).toEqual(expect.objectContaining({ kind: "published", artifact_id: artifactId }));
  const replay = { artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "result-1", payload_hash: payloadHash, published_at: new Date().toISOString() };
  expect(await records.publish_immediate(replay)).toEqual(expect.objectContaining({ kind: "already_applied", artifact_id: artifactId }));
  expect(await records.publish_immediate({ ...replay, payload_hash: "different" })).toEqual(expect.objectContaining({ kind: "idempotency_conflict", artifact_id: artifactId }));

  // A new repository has no memory inherited from the publisher or first ask.
  const afterRestart = new PostgresRunRecordRepository(sql);
  expect(await afterRestart.decide_run(runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
  await afterRestart.request_cleanup(workOrderId, now);
  await afterRestart.finish_cleanup(workOrderId, false, now);
  // Cleanup is an operational record; failure cannot reopen accepted work.
  expect(await afterRestart.decide_run(runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
  const persisted = await sql.query<{ readonly state: string; readonly record_version: string }>("SELECT state, record_version::text FROM oakridge.workflow_run WHERE id = $1", [runId]);
  expect(persisted[0]?.state).toBe("succeeded");
  expect(Number(persisted[0]?.record_version)).toBeGreaterThanOrEqual(4);
});
