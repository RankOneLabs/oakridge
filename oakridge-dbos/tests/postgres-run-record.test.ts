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
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }], created_at: now } as const;
  await records.initialize_straight_through(initialization);
  await records.initialize_straight_through(initialization);
  expect((await sql.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id = $1", [runId]))[0]?.record_version).toBe("1");
  expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.workflow_attempt WHERE run_id = $1", [runId]))[0]?.count).toBe("0");
  await expect(records.initialize_straight_through({ ...initialization, work_order_workflow_id: "conflicting-workflow" }))
    .rejects.toThrow("conflicts with its stored initialization");
  await expect(records.initialize_straight_through({ ...initialization, stage_instance_id: randomUUID() as StageInstanceId }))
    .rejects.toThrow("conflicts with its stored initialization");

  const concurrentDecisions = await Promise.all([records.decide_run(runId, now), new PostgresRunRecordRepository(sql).decide_run(runId, now)]);
  expect(concurrentDecisions.filter((decision) => decision.ok && decision.value.kind === "start_work")).toHaveLength(1);
  expect(concurrentDecisions.filter((decision) => decision.ok && decision.value.kind === "wait")).toHaveLength(1);
  await records.ensure_executor_attachment(workOrderId, "delegated_session", now);
  await records.attach_external(workOrderId, { kind: "kbbl_session", session_id: "session-1" }, now);
  const recoveredRecords = new PostgresRunRecordRepository(sql);
  const recoveredAttachment = await recoveredRecords.ensure_executor_attachment(workOrderId, "delegated_session", "2026-08-29T23:59:59.000Z");
  expect(recoveredAttachment).toEqual(expect.objectContaining({
    work_order_id: workOrderId, external_reference: { kind: "kbbl_session", session_id: "session-1" },
  }));
  expect(Date.parse(recoveredAttachment.updated_at)).toBe(Date.parse(now));
  expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]))[0]?.count).toBe("1");
  const body = { complete: true };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  expect(await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: "not-the-capability", idempotency_key: "unauthorized", payload_hash: payloadHash, published_at: now }))
    .toEqual({ kind: "invalid_capability", detail: "work-order capability was not accepted" });
  expect(await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "result-1", payload_hash: payloadHash, published_at: now })).toEqual(expect.objectContaining({ kind: "published", artifact_id: artifactId }));
  const replay = { artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "result-1", payload_hash: payloadHash, published_at: new Date().toISOString() };
  expect(await records.publish_artifact(replay)).toEqual(expect.objectContaining({ kind: "already_applied", artifact_id: artifactId }));
  expect(await records.publish_artifact({ ...replay, payload_hash: "different" })).toEqual(expect.objectContaining({ kind: "idempotency_conflict", artifact_id: artifactId }));

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

/** One straight-through run with a single gated output, for the pending/close tests below. */
const setupGatedRun = async (): Promise<{
  readonly records: PostgresRunRecordRepository; readonly runId: WorkflowRunId; readonly workOrderId: WorkOrderId;
  readonly capabilityHash: string; readonly now: string;
} | null> => {
  if (!sql) return null;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const unitId = "unit-1" as UnitId;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update("gate-secret").digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at)
    VALUES ($1,$2,1,'{}'::jsonb,false,$3::timestamptz)`, [definitionId, `v2-gate-test-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at)
    VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: unitId,
    work_order_id: workOrderId, work_order_workflow_id: `v2-work:${workOrderId}`, stage_key: "build", executor_type: "delegated_session",
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true,
      release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }, { name: "request_revision", disposition: "revise" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" } } ],
    created_at: now,
  });
  await records.decide_run(runId, now); // moves the work order available -> started
  return { records, runId, workOrderId, capabilityHash, now };
};

test("a gated publication parks the slot pending and opens its wait, atomically with the artifact fact", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runId, workOrderId, capabilityHash, now } = setup;
  const artifactId = randomUUID() as ArtifactId;
  const body = { plan: "draft" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "plan-1", payload_hash: payloadHash, published_at: now });
  expect(published.kind).toBe("pending");
  if (published.kind !== "pending") return;

  const slot = await sql!.query<{ readonly state: string; readonly release_wait_id: string; readonly artifact_revision_id: string }>(
    "SELECT state, release_wait_id::text, artifact_revision_id::text FROM oakridge.run_output_slot WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1) AND output_name = 'result'", [workOrderId]);
  expect(slot[0]).toEqual({ state: "pending", release_wait_id: published.wait_id, artifact_revision_id: artifactId });
  const wait = await sql!.query<{ readonly status: string; readonly run_unit_id: string; readonly output_name: string }>(
    "SELECT status, run_unit_id::text, output_name FROM oakridge.wait WHERE id = $1", [published.wait_id]);
  expect(wait[0]).toEqual(expect.objectContaining({ status: "open", output_name: "result" }));
  const artifactRow = await sql!.query<{ readonly lifecycle_state: string; readonly released_at: string | null }>("SELECT lifecycle_state, released_at FROM oakridge.artifact WHERE id = $1", [artifactId]);
  expect(artifactRow[0]).toEqual({ lifecycle_state: "current", released_at: null });
  const transition = await sql!.query<{ readonly operation: string; readonly wait_id: string; readonly resulting_record_version: string; readonly prior_record_version: string }>(
    "SELECT operation, wait_id::text, resulting_record_version::text, prior_record_version::text FROM oakridge.run_transition WHERE wait_id = $1", [published.wait_id]);
  expect(transition[0]?.operation).toBe("slot_pending");
  expect(Number(transition[0]?.resulting_record_version)).toBeGreaterThan(Number(transition[0]?.prior_record_version));

  // A wait still open means the run is waiting, not stuck and not satisfied —
  // even though a work order for this unit exists and started.
  const decision = await records.decide_run(runId, now);
  expect(decision).toEqual({ ok: true, value: { kind: "wait", record_version: expect.any(Number) } });
});

test("the owning gate command releases the wait and the slot atomically; the run then completes", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runId, workOrderId, capabilityHash, now } = setup;
  const artifactId = randomUUID() as ArtifactId;
  const body = { plan: "final" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "plan-2", payload_hash: payloadHash, published_at: now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);

  const closed = await records.close_output_wait({ wait_id: published.wait_id, disposition: "release", actor: "operator:sam", detail: "looks good", decided_at: now });
  expect(closed).toEqual({ kind: "released", artifact_id: artifactId, record_version: expect.any(Number) });

  const slot = await sql!.query<{ readonly state: string; readonly release_wait_id: string | null }>(
    "SELECT state, release_wait_id::text FROM oakridge.run_output_slot WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1) AND output_name = 'result'", [workOrderId]);
  expect(slot[0]).toEqual({ state: "released", release_wait_id: null });
  const artifactRow = await sql!.query<{ readonly lifecycle_state: string }>("SELECT lifecycle_state FROM oakridge.artifact WHERE id = $1", [artifactId]);
  expect(artifactRow[0]?.lifecycle_state).toBe("released");

  // Retrying the same disposition is absorbed, not reapplied.
  expect(await records.close_output_wait({ wait_id: published.wait_id, disposition: "release", actor: "operator:sam", detail: "looks good", decided_at: now }))
    .toEqual({ kind: "already_applied", record_version: expect.any(Number) });
  // A conflicting disposition on an already-closed wait is refused, not silently absorbed.
  const conflicting = await records.close_output_wait({ wait_id: published.wait_id, disposition: "invalidate", actor: "operator:sam", detail: null, decided_at: now });
  expect(conflicting.kind).toBe("wait_conflict");

  expect(await records.decide_run(runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
});

test("a rejected gate invalidates the slot and abandons the work order that produced it, instead of releasing", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runId, workOrderId, capabilityHash, now } = setup;
  const artifactId = randomUUID() as ArtifactId;
  const body = { plan: "wrong" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "plan-3", payload_hash: payloadHash, published_at: now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);

  const closed = await records.close_output_wait({ wait_id: published.wait_id, disposition: "invalidate", actor: "operator:sam", detail: "wrong approach", decided_at: now });
  expect(closed).toEqual({ kind: "invalidated", record_version: expect.any(Number) });

  const slot = await sql!.query<{ readonly state: string; readonly invalidation_reason: unknown }>(
    "SELECT state, invalidation_reason FROM oakridge.run_output_slot WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1) AND output_name = 'result'", [workOrderId]);
  expect(slot[0]?.state).toBe("invalidated");
  const order = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [workOrderId]);
  expect(order[0]?.state).toBe("abandoned");

  // Missing required work, no open wait, no available/started order: the unit needs new work, not a false "in progress".
  const decision = await records.decide_run(runId, now);
  expect(decision.ok && decision.value.kind).toBe("wait");
});

test("close_output_wait refuses a wait id that does not exist, and a slot that is not pending", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, now } = setup;
  expect(await records.close_output_wait({ wait_id: randomUUID() as never, disposition: "release", actor: "operator:sam", detail: null, decided_at: now }))
    .toEqual(expect.objectContaining({ kind: "wait_not_found" }));
});

test("a work order cannot publish outside its own unit's declared slot, nor after it is abandoned", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, workOrderId, capabilityHash, now } = setup;
  const payloadHash = createHash("sha256").update("{}").digest("hex");
  expect(await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "no_such_output", body: {},
    capability_hash: capabilityHash, idempotency_key: "wrong-slot", payload_hash: payloadHash, published_at: now }))
    .toEqual(expect.objectContaining({ kind: "slot_not_found" }));
  expect(await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: randomUUID() as WorkOrderId, output_name: "result", body: {},
    capability_hash: capabilityHash, idempotency_key: "wrong-order", payload_hash: payloadHash, published_at: now }))
    .toEqual(expect.objectContaining({ kind: "work_not_found" }));

  // Reject the pending output, which abandons the work order (see the
  // invalidation test above); a further publish from that same work order is
  // refused for being abandoned, ahead of the slot's own invalidated state.
  const first = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body: { plan: "v1" },
    capability_hash: capabilityHash, idempotency_key: "abandon-me", payload_hash: payloadHash, published_at: now });
  if (first.kind !== "pending") throw new Error(`expected pending, got ${first.kind}`);
  await records.close_output_wait({ wait_id: first.wait_id, disposition: "invalidate", actor: "operator:sam", detail: null, decided_at: now });
  expect(await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body: { plan: "v2" },
    capability_hash: capabilityHash, idempotency_key: "after-abandon", payload_hash: createHash("sha256").update(JSON.stringify({ plan: "v2" })).digest("hex"), published_at: now }))
    .toEqual(expect.objectContaining({ kind: "work_abandoned" }));
});

/**
 * Slice 3's own discipline test: a unit's satisfaction is decided from
 * released run-owned slots alone. An executor reporting terminal success is
 * diagnostic — `decide_run` never reads `executor_attachment` at all.
 */
test("an executor reporting terminal success does not settle a unit whose required slot is still pending", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runId, workOrderId, now } = setup;
  await records.ensure_executor_attachment(workOrderId, "delegated_session", now);
  await records.observe_executor(workOrderId, { kind: "ended_succeeded", metadata: {}, observed_at: now }, now);
  const decision = await records.decide_run(runId, now);
  // No artifact was ever published: the required slot is still empty, so the
  // unit needs work regardless of what the executor reported.
  expect(decision).toEqual({ ok: true, value: { kind: "wait", record_version: expect.any(Number) } });
  const unit = await sql!.query<{ readonly state: string }>(
    "SELECT state FROM oakridge.run_unit WHERE id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1)", [workOrderId]);
  expect(unit[0]?.state).not.toBe("satisfied");
});
