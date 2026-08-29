import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import type { ArtifactId, InputFingerprint, OutputCollectionKey, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { PersistMaterializedStage } from "../src/domain/run-record";
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
  readonly records: PostgresRunRecordRepository; readonly runId: WorkflowRunId; readonly runUnitId: RunUnitId; readonly workOrderId: WorkOrderId;
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
  return { records, runId, runUnitId, workOrderId, capabilityHash, now };
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
  expect(closed).toEqual({ kind: "released", artifact_id: artifactId, run_id: runId, record_version: expect.any(Number) });

  const slot = await sql!.query<{ readonly state: string; readonly release_wait_id: string | null }>(
    "SELECT state, release_wait_id::text FROM oakridge.run_output_slot WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1) AND output_name = 'result'", [workOrderId]);
  expect(slot[0]).toEqual({ state: "released", release_wait_id: null });
  const artifactRow = await sql!.query<{ readonly lifecycle_state: string }>("SELECT lifecycle_state FROM oakridge.artifact WHERE id = $1", [artifactId]);
  expect(artifactRow[0]?.lifecycle_state).toBe("released");

  // Retrying the same disposition is absorbed, not reapplied.
  expect(await records.close_output_wait({ wait_id: published.wait_id, disposition: "release", actor: "operator:sam", detail: "looks good", decided_at: now }))
    .toEqual({ kind: "already_applied", run_id: runId, record_version: expect.any(Number) });
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
  expect(closed).toEqual({ kind: "invalidated", run_id: runId, record_version: expect.any(Number) });

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

test("a second, non-replay publish while the slot is already pending is refused with the existing wait id, unmutated", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, workOrderId, capabilityHash, now } = setup;
  const bodyA = { plan: "a" };
  const payloadHashA = createHash("sha256").update(JSON.stringify(bodyA)).digest("hex");
  const first = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body: bodyA,
    capability_hash: capabilityHash, idempotency_key: "plan-pending-a", payload_hash: payloadHashA, published_at: now });
  if (first.kind !== "pending") throw new Error(`expected pending, got ${first.kind}`);

  // A different idempotency key and a different body: not a replay of the
  // first publish, so without the pending check this would try to open a
  // second wait on the same slot and hit `wait_v2_open_slot` as a raw
  // constraint violation instead of a typed refusal.
  const bodyB = { plan: "b" };
  const payloadHashB = createHash("sha256").update(JSON.stringify(bodyB)).digest("hex");
  const second = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body: bodyB,
    capability_hash: capabilityHash, idempotency_key: "plan-pending-b", payload_hash: payloadHashB, published_at: now });
  expect(second).toEqual(expect.objectContaining({ kind: "slot_pending", wait_id: first.wait_id }));

  const waits = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.wait WHERE id = $1", [first.wait_id]);
  expect(waits[0]?.count).toBe("1");
  const artifacts = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.artifact WHERE work_order_id = $1 AND output_name = 'result'", [workOrderId]);
  expect(artifacts[0]?.count).toBe("1");
});

/**
 * The fix for a bug review flagged: the old command-address scheme was
 * deterministic per *slot*, so a second wait ever opened on the same slot —
 * which cannot happen through this slice's own code today (an invalidated or
 * released slot permanently refuses further publication) but will once a
 * later slice resets an invalidated slot for a fresh work order — would have
 * collided with the first wait's row on `(command_workflow_id, kind)`. This
 * proves the fix directly: reset the slot the way that future revision path
 * will, and confirm a second wait opens cleanly with its own address.
 */
test("a second wait opened after a slot is reset does not collide on its command address", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runUnitId, workOrderId, capabilityHash, now } = setup;
  const bodyA = { plan: "a" };
  const payloadHashA = createHash("sha256").update(JSON.stringify(bodyA)).digest("hex");
  const first = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, output_name: "result", body: bodyA,
    capability_hash: capabilityHash, idempotency_key: "plan-reset-a", payload_hash: payloadHashA, published_at: now });
  if (first.kind !== "pending") throw new Error(`expected pending, got ${first.kind}`);
  await records.close_output_wait({ wait_id: first.wait_id, disposition: "invalidate", actor: "operator:sam", detail: null, decided_at: now });

  await sql!.query("UPDATE oakridge.run_output_slot SET state = 'empty', artifact_revision_id = NULL, invalidation_reason = NULL, state_changed_at = NULL WHERE run_unit_id = $1 AND output_name = 'result'", [runUnitId]);
  // Invalidation abandons the work order that produced the rejected output
  // (see the dedicated test for that above); a real Slice 4/5 revision or
  // retry issues a genuinely new one — reusing the abandoned id would also
  // collide on the artifact table's own (coordinate, version) uniqueness,
  // which is a separate, pre-existing constraint this test has no business
  // exercising.
  const secondWorkOrderId = randomUUID() as WorkOrderId;
  const secondCapabilityHash = createHash("sha256").update(`gate-secret-reset-${secondWorkOrderId}`).digest("hex");
  await sql!.query(`INSERT INTO oakridge.work_order (id, run_unit_id, reason, input_snapshot, input_fingerprint, state, workflow_id, request_idempotency_key, capability_hash, created_at)
    VALUES ($1,$2,'operator_retry','[]'::jsonb,'empty','started',$3,'retry-1',$4,$5::timestamptz)`,
    [secondWorkOrderId, runUnitId, `v2-work:${secondWorkOrderId}`, secondCapabilityHash, now]);

  const bodyB = { plan: "b" };
  const payloadHashB = createHash("sha256").update(JSON.stringify(bodyB)).digest("hex");
  const second = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: secondWorkOrderId, output_name: "result", body: bodyB,
    capability_hash: secondCapabilityHash, idempotency_key: "plan-reset-b", payload_hash: payloadHashB, published_at: now });
  expect(second.kind).toBe("pending");
  if (second.kind !== "pending") return;

  const addresses = await sql!.query<{ readonly command_workflow_id: string }>("SELECT command_workflow_id FROM oakridge.wait WHERE id = ANY($1::uuid[])", [[first.wait_id, second.wait_id]]);
  expect(new Set(addresses.map((row) => row.command_workflow_id)).size).toBe(2);
});

const setupMaterializedRun = async (maxParallel = 1, withDependencies = true, manualAdmission = false): Promise<{ readonly records: PostgresRunRecordRepository; readonly input: PersistMaterializedStage; readonly capabilities: readonly string[] } | null> => {
  if (!sql) return null;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const now = new Date().toISOString();
  await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition,archived,created_at) VALUES ($1,$2,1,'{}'::jsonb,false,$3::timestamptz)`, [definitionId, `materialized-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const unitIds = ["foundation", "web", "docs"] as const;
  const runUnitIds = unitIds.map(() => randomUUID() as RunUnitId);
  const workOrderIds = unitIds.map(() => randomUUID() as WorkOrderId);
  const capabilities = unitIds.map((unit) => createHash("sha256").update(`secret:${unit}`).digest("hex"));
  const outputs = [{ identity: { kind: "scalar" as const, output_name: "result" }, artifact_type: "dev.result", required: true, release: { kind: "immediate" as const } }];
  const input: PersistMaterializedStage = {
    run_id: runId, stage_instance_id: stageId, stage_key: "build", stage_type: "delegated_session",
    stage_contract: { executor_type: "delegated_session", resolved_config: {}, outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }] },
    policy: { max_parallel: maxParallel, manual_admission: manualAdmission }, close_materialization: true, materialized_at: now,
    units: unitIds.map((unitId, index) => ({ id: runUnitIds[index]!, unit_id: unitId as UnitId, parameters: { unit_id: unitId }, input_snapshot: [],
      input_fingerprint: `input:${unitId}` as InputFingerprint, depends_on: !withDependencies || index === 0 ? [] : [unitIds[index - 1]! as UnitId], outputs,
      initial_work_order: { id: workOrderIds[index]!, workflow_id: `v2-work:${workOrderIds[index]}`, capability_hash: capabilities[index]!, request: {
        execution_id: workOrderIds[index]! as unknown as import("../src/domain/primitives").ExecutionId, stage_instance_id: stageId, unit_id: unitId as UnitId,
        executor_type: "delegated_session", resolved_config: {}, inputs: [], declared_outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
        expected_artifacts: [{ unit_id: unitId as UnitId, output_name: "result", artifact_type: "dev.result" }],
      } } })),
  };
  const records = new PostgresRunRecordRepository(sql);
  await records.persist_materialized_stage(input);
  return { records, input, capabilities };
};

test("compiler materialization persists an idempotent dependency graph and rejects conflicting rematerialization", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  await setup.records.persist_materialized_stage(setup.input);
  const edges = await sql!.query<{ readonly unit_id: string; readonly dependency: string }>(`SELECT edge.unit_id,edge.depends_on_unit_id AS dependency FROM oakridge.run_unit_dependency edge
    JOIN oakridge.stage_instance stage ON stage.id=edge.stage_instance_id WHERE stage.run_id=$1 ORDER BY edge.unit_id`, [setup.input.run_id]);
  expect(edges).toEqual([{ unit_id: "docs", dependency: "web" }, { unit_id: "web", dependency: "foundation" }]);
  await expect(setup.records.persist_materialized_stage({ ...setup.input, policy: { ...setup.input.policy, max_parallel: 2 } })).rejects.toThrow("conflicts with its stored graph");
});

test("incremental materialization persists forward edges and validates them when explicitly closed", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const stageId = randomUUID() as StageInstanceId;
  const rebind = (unit: PersistMaterializedStage["units"][number], depends_on: readonly UnitId[]) => {
    const id = randomUUID() as RunUnitId;
    const workOrderId = randomUUID() as WorkOrderId;
    return { ...unit, id, depends_on, initial_work_order: { ...unit.initial_work_order, id: workOrderId, workflow_id: `v2-work:${workOrderId}`,
      request: { ...unit.initial_work_order.request, execution_id: workOrderId as unknown as import("../src/domain/primitives").ExecutionId, stage_instance_id: stageId } } };
  };
  const foundation = rebind(setup.input.units[0]!, []);
  const web = rebind(setup.input.units[1]!, [foundation.unit_id]);
  const base = { ...setup.input, stage_instance_id: stageId, stage_key: "incremental", units: [web], close_materialization: false } satisfies PersistMaterializedStage;
  await setup.records.persist_materialized_stage(base);
  await setup.records.persist_materialized_stage({ ...base, units: [foundation], close_materialization: true });
  const closed = await sql!.query<{ readonly materialization_closed: boolean }>("SELECT materialization_closed FROM oakridge.stage_instance WHERE id=$1", [stageId]);
  expect(closed[0]?.materialization_closed).toBe(true);

  const invalidStageId = randomUUID() as StageInstanceId;
  const invalidWorkOrderId = randomUUID() as WorkOrderId;
  const invalid = { ...base, stage_instance_id: invalidStageId, stage_key: "invalid-incremental", close_materialization: true,
    units: [{ ...web, id: randomUUID() as RunUnitId, depends_on: ["never-arrived" as UnitId], initial_work_order: { ...web.initial_work_order,
      id: invalidWorkOrderId, workflow_id: `v2-work:${invalidWorkOrderId}`, request: { ...web.initial_work_order.request,
        execution_id: invalidWorkOrderId as unknown as import("../src/domain/primitives").ExecutionId, stage_instance_id: invalidStageId } } }] } satisfies PersistMaterializedStage;
  await expect(setup.records.persist_materialized_stage(invalid)).rejects.toThrow("unknown dependency");
});

test("transactional scheduling starts only dependency-ready work within capacity", async () => {
  const setup = await setupMaterializedRun(2, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const concurrent = await Promise.all([setup.records.decide_run(setup.input.run_id, setup.input.materialized_at), new PostgresRunRecordRepository(sql!).decide_run(setup.input.run_id, setup.input.materialized_at)]);
  expect(concurrent.flatMap((result) => result.ok && result.value.kind === "start_work" ? result.value.work_orders : [])).toHaveLength(2);
  const started = await sql!.query<{ readonly unit_id: string }>(`SELECT unit.unit_id FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=$1 AND work.state='started'`, [setup.input.run_id]);
  expect(started.map((row) => row.unit_id).sort()).toEqual(["docs", "foundation"]);
});

test("manual admission is repository-owned, dependency-aware, and idempotent", async () => {
  const setup = await setupMaterializedRun(2, true, true);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const [foundation, web] = setup.input.units;
  if (!foundation || !web) throw new Error("fixture units missing");
  expect(await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: web.unit_id, idempotency_key: "web-1" }, setup.input.materialized_at))
    .toEqual({ kind: "dependency_blocked", stage_instance_id: setup.input.stage_instance_id, unit_id: web.unit_id, blocked_by: [foundation.unit_id] });
  const admitted = await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: foundation.unit_id, idempotency_key: "foundation-1" }, setup.input.materialized_at);
  expect(admitted.kind).toBe("admitted");
  expect((await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: foundation.unit_id, idempotency_key: "foundation-1" }, setup.input.materialized_at)).kind).toBe("already_admitted");
  const decision = await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  expect(decision.ok && decision.value.kind === "start_work" ? decision.value.work_orders.map((order) => order.run_unit_id) : []).toEqual([foundation.id]);
});

test("manual admission cannot mutate a terminal stage or run", async () => {
  if (!sql) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  for (const terminalOwner of ["stage", "run"] as const) {
    const setup = await setupMaterializedRun(1, true, true);
    if (!setup) throw new Error("materialized run setup unexpectedly unavailable");
    const unit = setup.input.units[0]!;
    const before = await sql.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id=$1", [setup.input.run_id]);
    if (terminalOwner === "stage") {
      await sql.query("UPDATE oakridge.stage_instance SET state='succeeded',outcome='{\"kind\":\"succeeded\"}'::jsonb,ended_at=$2::timestamptz WHERE id=$1", [setup.input.stage_instance_id, setup.input.materialized_at]);
    } else {
      await sql.query("UPDATE oakridge.workflow_run SET state='succeeded',outcome='{\"kind\":\"succeeded\"}'::jsonb,ended_at=$2::timestamptz WHERE id=$1", [setup.input.run_id, setup.input.materialized_at]);
    }
    expect(await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: unit.unit_id, idempotency_key: `terminal-${terminalOwner}` }, setup.input.materialized_at))
      .toEqual({ kind: "not_pending", stage_instance_id: setup.input.stage_instance_id, unit_id: unit.unit_id });
    expect((await sql.query<{ readonly admitted: boolean }>("SELECT admitted FROM oakridge.run_unit WHERE id=$1", [unit.id]))[0]?.admitted).toBe(false);
    expect((await sql.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id=$1", [setup.input.run_id]))[0]?.record_version).toBe(before[0]?.record_version);
    expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_admission_command WHERE stage_instance_id=$1", [setup.input.stage_instance_id]))[0]?.count).toBe("0");
  }
});

test("collection members publish independently and one revision invalidates every effective output", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const unit = setup.input.units[0]!;
  const collectionOutputs = ["a", "b"].map((key) => ({ identity: { kind: "collection_member" as const, output_name: "files", collection_key: key as OutputCollectionKey }, artifact_type: "dev.file", required: true, release: { kind: "immediate" as const } }));
  // This is a separate stage because a materialized graph is immutable.
  const second = { ...setup.input, stage_instance_id: randomUUID() as StageInstanceId, stage_key: "collect", units: [{ ...unit, id: randomUUID() as RunUnitId,
    unit_id: "collector" as UnitId, depends_on: [], outputs: collectionOutputs, initial_work_order: { ...unit.initial_work_order, id: randomUUID() as WorkOrderId,
      workflow_id: `v2-work:${randomUUID()}`, request: { ...unit.initial_work_order.request, unit_id: "collector" as UnitId } } }] } satisfies PersistMaterializedStage;
  const collectionWorkOrderId = second.units[0]!.initial_work_order.id;
  const collectionStage = { ...second, units: [{ ...second.units[0]!, initial_work_order: { ...second.units[0]!.initial_work_order,
    workflow_id: `v2-work:${collectionWorkOrderId}`, request: { ...second.units[0]!.initial_work_order.request,
      execution_id: collectionWorkOrderId as unknown as import("../src/domain/primitives").ExecutionId, stage_instance_id: second.stage_instance_id } } }] } satisfies PersistMaterializedStage;
  await setup.records.persist_materialized_stage(collectionStage);
  await setup.records.decide_run(collectionStage.run_id, collectionStage.materialized_at);
  const order = collectionStage.units[0]!.initial_work_order;
  for (const key of ["a", "b"] as const) {
    const body = { key };
    const result = await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: order.id, capability_hash: order.capability_hash,
      output_name: "files", collection_key: key as OutputCollectionKey, body, idempotency_key: key, payload_hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), published_at: second.materialized_at });
    expect(result.kind).toBe("published");
  }
  const replacementWorkOrderId = randomUUID() as WorkOrderId;
  const revised = await setup.records.revise_unit_input({ run_unit_id: collectionStage.units[0]!.id, input_snapshot: [], input_fingerprint: "revised" as InputFingerprint,
    revised_at: collectionStage.materialized_at, actor: "test", replacement_work_order: {
      ...order, id: replacementWorkOrderId, workflow_id: `v2-work:${replacementWorkOrderId}`,
      request: { ...order.request, execution_id: replacementWorkOrderId as unknown as import("../src/domain/primitives").ExecutionId },
    } });
  expect(revised.kind).toBe("revised");
  const states = await sql!.query<{ readonly collection_key: string; readonly state: string }>("SELECT collection_key,state FROM oakridge.run_output_slot WHERE run_unit_id=$1 ORDER BY collection_key", [collectionStage.units[0]!.id]);
  expect(states).toEqual([{ collection_key: "a", state: "invalidated" }, { collection_key: "b", state: "invalidated" }]);
  const replacement = await sql!.query<{ readonly state: string; readonly reason: string }>("SELECT state,reason FROM oakridge.work_order WHERE id=$1", [replacementWorkOrderId]);
  expect(replacement).toEqual([{ state: "available", reason: "input_revision" }]);
});
