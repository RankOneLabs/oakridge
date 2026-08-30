import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import type { AskResult } from "../src/decision/commands";
import type { ExecutionRequest } from "../src/domain/execution";
import type { ArtifactId, ExecutionId, InputFingerprint, OutputCollectionKey, Result, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { OutputReleaseContract } from "../src/domain/compiled-workflow";
import type { MaterializedRunOutput, PersistMaterializedStage } from "../src/domain/run-record";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresArtifactRevisionRepository } from "../src/storage/postgres-domain";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import type { RunRecordRepositoryError } from "../src/storage/repositories";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

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
    VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `v2-test-${runId}`, now]);
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
  await expect(records.initialize_straight_through({ ...initialization, work_order_workflow_id: "conflicting-workflow" }))
    .rejects.toThrow("conflicts with its stored initialization");
  await expect(records.initialize_straight_through({ ...initialization, stage_instance_id: randomUUID() as StageInstanceId }))
    .rejects.toThrow("conflicts with its stored initialization");

  const concurrentDecisions = await Promise.all([records.decide_run(runId, now), new PostgresRunRecordRepository(sql).decide_run(runId, now)]);
  expect(concurrentDecisions.filter((decision) => decision.ok && decision.value.kind === "recheck")).toHaveLength(1);
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
  expect(await decideUntilSettled(afterRestart, runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
  await afterRestart.request_cleanup(workOrderId, now);
  await afterRestart.finish_cleanup(workOrderId, false, now);
  // Cleanup is an operational record; failure cannot reopen accepted work.
  expect(await afterRestart.decide_run(runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
  const persisted = await sql.query<{ readonly state: string; readonly record_version: string }>("SELECT state, record_version::text FROM oakridge.workflow_run WHERE id = $1", [runId]);
  expect(persisted[0]?.state).toBe("succeeded");
  expect(Number(persisted[0]?.record_version)).toBeGreaterThanOrEqual(6);
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
    VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `v2-gate-test-${runId}`, now]);
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

  expect(await decideUntilSettled(records, runId, now)).toEqual({ ok: true, value: { kind: "complete", outcome: { kind: "succeeded" } } });
});

test("an authored v2 gate action selects its persisted disposition, including terminal failure", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const body = { plan: "rejected" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: setup.workOrderId,
    output_name: "result", body, capability_hash: setup.capabilityHash, idempotency_key: "terminal-gate", payload_hash: payloadHash, published_at: setup.now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);
  const release = { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "reject", disposition: "terminal" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" };
  await sql!.query("UPDATE oakridge.run_output_slot SET release_policy=$2::jsonb WHERE run_unit_id=$1", [setup.runUnitId, release]);
  await sql!.query("UPDATE oakridge.wait SET closes_on=$2::jsonb WHERE id=$1", [published.wait_id,
    { kind: "gate", gate_step: "artifact_approval", actions: ["reject"] }]);
  expect(await setup.records.decide_gate_wait({ wait_id: published.wait_id, action: "unknown", actor: "operator:test", detail: null, decided_at: setup.now }))
    .toEqual(expect.objectContaining({ kind: "wait_conflict" }));
  expect(await setup.records.decide_gate_wait({ wait_id: published.wait_id, action: "reject", actor: "operator:test", detail: "not acceptable", decided_at: setup.now }))
    .toEqual(expect.objectContaining({ kind: "invalidated" }));
  const unit = await sql!.query<{ readonly state: string; readonly code: string }>("SELECT state,outcome->>'code' AS code FROM oakridge.run_unit WHERE id=$1", [setup.runUnitId]);
  expect(unit[0]).toEqual({ state: "failed", code: "gate_rejected" });
});

test("an upstream-targeted revision closes its gate and upstream handoff in one run-owned transaction", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const upstreamArtifactId = randomUUID() as ArtifactId;
  const upstreamBody = { build: "candidate" };
  const handoff = { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } as const;
  await sql!.query("UPDATE oakridge.run_output_slot SET release_policy=$2::jsonb WHERE run_unit_id=$1", [setup.runUnitId, handoff]);
  const upstream = await setup.records.publish_artifact({ artifact_id: upstreamArtifactId, work_order_id: setup.workOrderId,
    output_name: "result", body: upstreamBody, capability_hash: setup.capabilityHash, idempotency_key: "upstream-handoff",
    payload_hash: createHash("sha256").update(JSON.stringify(upstreamBody)).digest("hex"), published_at: setup.now });
  if (upstream.kind !== "pending") throw new Error(`expected pending upstream handoff, got ${upstream.kind}`);

  const downstreamStageId = randomUUID() as StageInstanceId;
  const downstreamUnitId = randomUUID() as RunUnitId;
  const downstreamWorkId = randomUUID() as WorkOrderId;
  const downstreamCapability = createHash("sha256").update("downstream-secret").digest("hex");
  const input = [{ artifact_id: upstreamArtifactId, artifact_type: "dev.result", output_name: "result", unit_id: "unit-1" as UnitId, body: upstreamBody }];
  await setup.records.initialize_straight_through({ run_id: setup.runId, stage_instance_id: downstreamStageId, run_unit_id: downstreamUnitId,
    unit_id: "assessment" as UnitId, work_order_id: downstreamWorkId, work_order_workflow_id: `v2-work:${downstreamWorkId}`,
    stage_key: "assessment", executor_type: "delegated_session", work_order_capability_hash: downstreamCapability,
    resolved_config: {}, parameters: {}, input_snapshot: input, input_fingerprint: "upstream-v1" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.assessment", required: true, release: { kind: "gate",
      steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }, { name: "request_revision", disposition: "revise" }] }],
      requires_zero_open_review_items: false, revision_target: "upstream_handoff" } }], created_at: setup.now });
  await setup.records.decide_run(setup.runId, setup.now);
  const assessmentBody = { verdict: "revise" };
  const assessment = await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: downstreamWorkId,
    output_name: "result", body: assessmentBody, capability_hash: downstreamCapability, idempotency_key: "assessment-gate",
    payload_hash: createHash("sha256").update(JSON.stringify(assessmentBody)).digest("hex"), published_at: setup.now });
  if (assessment.kind !== "pending") throw new Error(`expected pending assessment gate, got ${assessment.kind}`);
  expect(await setup.records.decide_gate_wait({ wait_id: assessment.wait_id, action: "request_revision", actor: "operator:test",
    detail: "revise upstream", decided_at: setup.now })).toEqual(expect.objectContaining({ kind: "invalidated" }));
  const waits = await sql!.query<{ readonly id: string; readonly status: string }>(
    "SELECT id::text,status FROM oakridge.wait WHERE id=ANY($1::uuid[]) ORDER BY id", [[upstream.wait_id, assessment.wait_id]]);
  expect(waits).toHaveLength(2);
  expect(waits.every((wait) => wait.status === "closed")).toBe(true);
  const slots = await sql!.query<{ readonly state: string }>(
    "SELECT state FROM oakridge.run_output_slot WHERE run_unit_id=ANY($1::uuid[]) ORDER BY run_unit_id", [[setup.runUnitId, downstreamUnitId]]);
  expect(slots.map((slot) => slot.state)).toEqual(["invalidated", "invalidated"]);
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

const GATE_RELEASE: OutputReleaseContract = { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }, { name: "request_revision", disposition: "revise" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" };

const payloadHashOf = (body: unknown): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

/**
 * One fresh single-unit stage on an existing materialized run, whose work
 * order carries v2 publication authority the way `resolveWorkOrder` always
 * produces it — the shape `retry_unit` rebinds from.
 */
const materializeSingleUnitStage = async (setup: NonNullable<Awaited<ReturnType<typeof setupMaterializedRun>>>, stageKey: string, unitId: string, outputs: readonly MaterializedRunOutput[]) => {
  const template = setup.input.units[0]!;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const capability = `capability:${workOrderId}`;
  const capabilityHash = createHash("sha256").update(capability).digest("hex");
  const declared = [...new Map(outputs.map((output) => [output.identity.output_name, { name: output.identity.output_name, artifact_type: output.artifact_type, required: true }])).values()];
  const request: ExecutionRequest = { ...template.initial_work_order.request, execution_id: workOrderId as unknown as ExecutionId, stage_instance_id: stageId, unit_id: unitId as UnitId,
    resolved_config: { runtime: "claude-code", rendered_prompt: "work", workdir: "/repo", session_name: unitId, publication: { base_url: "http://oakridge.test", work_order_id: workOrderId, capability } },
    declared_outputs: declared,
    expected_artifacts: outputs.map((output) => ({ unit_id: (output.identity.kind === "collection_member" ? output.identity.collection_key : unitId) as unknown as UnitId, output_name: output.identity.output_name, artifact_type: output.artifact_type })) };
  const stage: PersistMaterializedStage = { ...setup.input, stage_instance_id: stageId, stage_key: stageKey, policy: { max_parallel: 4, manual_admission: false },
    units: [{ ...template, id: runUnitId, unit_id: unitId as UnitId, depends_on: [], outputs, initial_work_order: { id: workOrderId, workflow_id: `v2-work:${workOrderId}`, capability_hash: capabilityHash, request } }] };
  await setup.records.persist_materialized_stage(stage);
  await setup.records.decide_run(stage.run_id, stage.materialized_at); // available -> started
  return { stage, stageId, runUnitId, workOrderId, capabilityHash, at: stage.materialized_at };
};

interface StoredExecutionBasis { readonly capability_hash: string; readonly execution_request: ExecutionRequest }
const storedWorkOrder = async (workOrderId: WorkOrderId): Promise<StoredExecutionBasis> => {
  const rows = await sql!.query<StoredExecutionBasis>("SELECT capability_hash, execution_request FROM oakridge.work_order WHERE id = $1", [workOrderId]);
  if (!rows[0]) throw new Error(`work order '${workOrderId}' was not stored`);
  return rows[0];
};
const publicationOf = (request: ExecutionRequest): { readonly work_order_id: string; readonly capability: string } => {
  const publication = (request.resolved_config as { readonly publication?: { readonly work_order_id: string; readonly capability: string } }).publication;
  if (!publication) throw new Error("execution request carries no publication authority");
  return publication;
};

/**
 * The operator's correction loop at the repository: a gated output is
 * rejected, the operator retries the unit, and the retry's work order
 * publishes the replacement into the invalidated slot as a fresh chain root
 * with a wait of its own. The retry's request is rebound to the new work
 * order — its own PUT target and its own capability, never the abandoned
 * order's — and names only the output still owed.
 */
test("a rejected gated output is replaced by the operator's retry as a fresh chain root with its own wait", async () => {
  const setup = await setupMaterializedRun(4, false, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const fixture = await materializeSingleUnitStage(setup, "plan", "planner", [{ identity: { kind: "scalar", output_name: "plan" }, artifact_type: "dev.plan", required: true, release: GATE_RELEASE }]);
  const publish = (workOrderId: WorkOrderId, capabilityHash: string, key: string, body: unknown) => setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId,
    capability_hash: capabilityHash, output_name: "plan", body: body as never, idempotency_key: key, payload_hash: payloadHashOf(body), published_at: fixture.at });

  const first = await publish(fixture.workOrderId, fixture.capabilityHash, "plan-v1", { plan: "v1" });
  if (first.kind !== "pending") throw new Error(`expected pending, got ${first.kind}`);
  await setup.records.close_output_wait({ wait_id: first.wait_id, disposition: "invalidate", actor: "operator:sam", detail: "redo it", decided_at: fixture.at });
  const effectiveAfterRejection = await new PostgresArtifactRevisionRepository(sql!).list_effective_for_run(setup.input.run_id);
  expect(effectiveAfterRejection.some((artifact) => artifact.id === first.artifact_id)).toBe(false);
  // The scalar producer had nothing left to emit, so the rejection abandoned it.
  expect(await publish(fixture.workOrderId, fixture.capabilityHash, "plan-v2-from-old-order", { plan: "v2" })).toEqual(expect.objectContaining({ kind: "work_abandoned" }));

  const retry = await setup.records.retry_unit({ target: { kind: "stage_unit", stage_instance_id: fixture.stageId, unit_id: "planner" as UnitId }, idempotency_key: "retry-1", actor: "operator:sam" }, fixture.at);
  if (retry.kind !== "created") throw new Error(`expected created, got ${retry.kind}`);
  const stored = await storedWorkOrder(retry.work_order.id);
  const publication = publicationOf(stored.execution_request);
  expect(publication.work_order_id).toBe(retry.work_order.id);
  expect(createHash("sha256").update(publication.capability).digest("hex")).toBe(stored.capability_hash);
  expect(stored.capability_hash).not.toBe(fixture.capabilityHash);
  expect(stored.execution_request.execution_id).toBe(retry.work_order.id as unknown as ExecutionId);
  expect(stored.execution_request.expected_artifacts).toEqual([{ unit_id: "planner" as UnitId, output_name: "plan", artifact_type: "dev.plan" as never }]);
  // The abandoned order's capability does not authenticate the retry.
  expect(await publish(retry.work_order.id, fixture.capabilityHash, "plan-v2-stale-capability", { plan: "v2" })).toEqual(expect.objectContaining({ kind: "invalid_capability" }));

  await setup.records.decide_run(setup.input.run_id, fixture.at); // starts the retry
  const second = await publish(retry.work_order.id, stored.capability_hash, "plan-v2", { plan: "v2" });
  if (second.kind !== "pending") throw new Error(`expected pending, got ${second.kind}`);
  expect(second.wait_id).not.toBe(first.wait_id);
  const addresses = await sql!.query<{ readonly command_workflow_id: string }>("SELECT command_workflow_id FROM oakridge.wait WHERE id = ANY($1::uuid[])", [[first.wait_id, second.wait_id]]);
  expect(new Set(addresses.map((row) => row.command_workflow_id)).size).toBe(2);

  const artifacts = await sql!.query<{ readonly id: string; readonly lifecycle_state: string; readonly version: number; readonly parent_artifact_id: string | null; readonly chain_id: string; readonly execution_id: string }>(
    "SELECT id::text, lifecycle_state, version, parent_artifact_id::text, chain_id::text, execution_id FROM oakridge.artifact WHERE id = ANY($1::uuid[]) ORDER BY created_at, version", [[first.artifact_id, second.artifact_id]]);
  expect(artifacts.find((artifact) => artifact.id === first.artifact_id)).toEqual(expect.objectContaining({ lifecycle_state: "withdrawn" }));
  expect(artifacts.find((artifact) => artifact.id === second.artifact_id)).toEqual(expect.objectContaining({ lifecycle_state: "current", version: 1, parent_artifact_id: null, chain_id: second.artifact_id, execution_id: retry.work_order.id }));
  const slot = await sql!.query<{ readonly state: string; readonly artifact_revision_id: string; readonly updated_by_work_order_id: string }>(
    "SELECT state, artifact_revision_id::text, updated_by_work_order_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = 'plan'", [fixture.runUnitId]);
  expect(slot[0]).toEqual({ state: "pending", artifact_revision_id: second.artifact_id, updated_by_work_order_id: retry.work_order.id });
  const transition = await sql!.query<{ readonly detail: { readonly replaced_artifact_id?: string } }>(
    "SELECT detail FROM oakridge.run_transition WHERE run_id = $1 AND operation = 'slot_pending' AND work_order_id = $2", [setup.input.run_id, retry.work_order.id]);
  expect(transition[0]?.detail.replaced_artifact_id).toBe(first.artifact_id);
});

/**
 * Input revision abandons only active work. A `completed` order keeps a valid
 * capability and its agent may still be alive — it must not publish the
 * old input's output into the slot the revision just invalidated. The
 * revision's own order may, and afterwards the effective-artifact reads
 * return the replacement alone even though the predecessor stays `released`.
 */
test("a completed work order cannot publish into a slot invalidated by input revision; the revision's order can, and reads follow the slot", async () => {
  const setup = await setupMaterializedRun(4, false, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const fixture = await materializeSingleUnitStage(setup, "summary", "writer", [{ identity: { kind: "scalar", output_name: "summary" }, artifact_type: "dev.summary", required: true, release: { kind: "immediate" } }]);
  const publish = (workOrderId: WorkOrderId, capabilityHash: string, key: string, body: unknown) => setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId,
    capability_hash: capabilityHash, output_name: "summary", body: body as never, idempotency_key: key, payload_hash: payloadHashOf(body), published_at: fixture.at });

  const first = await publish(fixture.workOrderId, fixture.capabilityHash, "summary-v1", { summary: "v1" });
  if (first.kind !== "published") throw new Error(`expected published, got ${first.kind}`);
  for (let asks = 0; asks < 3; asks += 1) await setup.records.decide_run(setup.input.run_id, fixture.at);
  expect((await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [fixture.workOrderId]))[0]?.state).toBe("completed");

  const replacementWorkOrderId = randomUUID() as WorkOrderId;
  const replacementCapability = `capability:${replacementWorkOrderId}`;
  const replacementCapabilityHash = createHash("sha256").update(replacementCapability).digest("hex");
  const basis = fixture.stage.units[0]!.initial_work_order.request;
  const revised = await setup.records.revise_unit_input({ run_unit_id: fixture.runUnitId, input_snapshot: [], input_fingerprint: "revised" as InputFingerprint, revised_at: fixture.at, actor: "test",
    replacement_work_order: { id: replacementWorkOrderId, workflow_id: `v2-work:${replacementWorkOrderId}`, capability_hash: replacementCapabilityHash,
      request: { ...basis, execution_id: replacementWorkOrderId as unknown as ExecutionId, resolved_config: { ...(basis.resolved_config as object), publication: { base_url: "http://oakridge.test", work_order_id: replacementWorkOrderId, capability: replacementCapability } } } } });
  expect(revised.kind).toBe("revised");
  const slotBefore = (await sql!.query<{ readonly state: string; readonly artifact_revision_id: string | null }>("SELECT state, artifact_revision_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1", [fixture.runUnitId]))[0];
  expect(slotBefore).toEqual({ state: "invalidated", artifact_revision_id: first.artifact_id });

  expect(await publish(fixture.workOrderId, fixture.capabilityHash, "summary-v2-from-completed-order", { summary: "stale" })).toEqual(expect.objectContaining({ kind: "work_not_active" }));
  expect((await sql!.query<{ readonly state: string; readonly artifact_revision_id: string | null }>("SELECT state, artifact_revision_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1", [fixture.runUnitId]))[0]).toEqual(slotBefore);

  await setup.records.decide_run(setup.input.run_id, fixture.at); // starts the replacement
  const second = await publish(replacementWorkOrderId, replacementCapabilityHash, "summary-v2", { summary: "v2" });
  if (second.kind !== "published") throw new Error(`expected published, got ${second.kind}`);
  const lifecycles = await sql!.query<{ readonly id: string; readonly lifecycle_state: string }>("SELECT id::text, lifecycle_state FROM oakridge.artifact WHERE id = ANY($1::uuid[])", [[first.artifact_id, second.artifact_id]]);
  expect(lifecycles.find((row) => row.id === first.artifact_id)?.lifecycle_state).toBe("released");
  expect(lifecycles.find((row) => row.id === second.artifact_id)?.lifecycle_state).toBe("released");
  const effective = (await new PostgresArtifactRevisionRepository(sql!).list_effective_for_run(setup.input.run_id)).filter((artifact) => artifact.output_name === "summary");
  expect(effective.map((artifact) => artifact.id)).toEqual([second.artifact_id]);
});

/**
 * One rejected collection member is not a verdict on the members its
 * producer has not published yet: the producer keeps running while it still
 * owes an empty sibling and is abandoned only once a rejection leaves it
 * nothing to emit. It cannot re-publish the rejected member itself — that is
 * the operator retry's, whose request names the rejected members by their
 * collection keys and publishes them under its own work order.
 */
test("rejecting one collection member keeps a producer that still owes a sibling; the retry replaces the rejected members", async () => {
  const setup = await setupMaterializedRun(4, false, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const members = ["a", "b"].map((key) => ({ identity: { kind: "collection_member" as const, output_name: "files", collection_key: key as OutputCollectionKey }, artifact_type: "dev.file", required: true, release: GATE_RELEASE }));
  const fixture = await materializeSingleUnitStage(setup, "collect", "collector", members);
  const publish = (workOrderId: WorkOrderId, capabilityHash: string, key: "a" | "b", idempotencyKey: string, body: unknown) => setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId,
    capability_hash: capabilityHash, output_name: "files", collection_key: key as OutputCollectionKey, body: body as never, idempotency_key: idempotencyKey, payload_hash: payloadHashOf(body), published_at: fixture.at });
  const workOrderState = async (): Promise<string | undefined> => (await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [fixture.workOrderId]))[0]?.state;
  const slots = () => sql!.query<{ readonly collection_key: string; readonly state: string; readonly artifact_revision_id: string | null }>("SELECT collection_key, state, artifact_revision_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 ORDER BY collection_key", [fixture.runUnitId]);

  const firstA = await publish(fixture.workOrderId, fixture.capabilityHash, "a", "a-v1", { member: "a", revision: 1 });
  if (firstA.kind !== "pending") throw new Error(`expected pending, got ${firstA.kind}`);
  await setup.records.close_output_wait({ wait_id: firstA.wait_id, disposition: "invalidate", actor: "operator:sam", detail: "redo a", decided_at: fixture.at });
  expect(await workOrderState()).toBe("started");

  const firstB = await publish(fixture.workOrderId, fixture.capabilityHash, "b", "b-v1", { member: "b", revision: 1 });
  if (firstB.kind !== "pending") throw new Error(`expected pending, got ${firstB.kind}`);
  expect(await publish(fixture.workOrderId, fixture.capabilityHash, "a", "a-v2", { member: "a", revision: 2 })).toEqual(expect.objectContaining({ kind: "slot_invalidated" }));
  expect(await slots()).toEqual([expect.objectContaining({ collection_key: "a", state: "invalidated", artifact_revision_id: firstA.artifact_id }), expect.objectContaining({ collection_key: "b", state: "pending", artifact_revision_id: firstB.artifact_id })]);

  // Nothing empty is left to emit, so this rejection abandons the producer.
  await setup.records.close_output_wait({ wait_id: firstB.wait_id, disposition: "invalidate", actor: "operator:sam", detail: "redo b", decided_at: fixture.at });
  expect(await workOrderState()).toBe("abandoned");
  expect((await publish(fixture.workOrderId, fixture.capabilityHash, "b", "b-v2", { member: "b", revision: 2 })).kind).toBe("work_abandoned");

  const retry = await setup.records.retry_unit({ target: { kind: "stage_unit", stage_instance_id: fixture.stageId, unit_id: "collector" as UnitId }, idempotency_key: "retry-collection", actor: "operator:sam" }, fixture.at);
  if (retry.kind !== "created") throw new Error(`expected created, got ${retry.kind}`);
  const stored = await storedWorkOrder(retry.work_order.id);
  expect(stored.execution_request.expected_artifacts).toEqual([
    { unit_id: "a" as UnitId, output_name: "files", artifact_type: "dev.file" as never },
    { unit_id: "b" as UnitId, output_name: "files", artifact_type: "dev.file" as never },
  ]);
  await setup.records.decide_run(setup.input.run_id, fixture.at); // starts the retry
  const secondA = await publish(retry.work_order.id, stored.capability_hash, "a", "a-v2-retry", { member: "a", revision: 2 });
  const secondB = await publish(retry.work_order.id, stored.capability_hash, "b", "b-v2-retry", { member: "b", revision: 2 });
  if (secondA.kind !== "pending" || secondB.kind !== "pending") throw new Error(`expected pending, got ${secondA.kind}/${secondB.kind}`);
  expect(await slots()).toEqual([expect.objectContaining({ collection_key: "a", state: "pending", artifact_revision_id: secondA.artifact_id }), expect.objectContaining({ collection_key: "b", state: "pending", artifact_revision_id: secondB.artifact_id })]);
  const withdrawn = await sql!.query<{ readonly lifecycle_state: string }>("SELECT lifecycle_state FROM oakridge.artifact WHERE id = ANY($1::uuid[])", [[firstA.artifact_id, firstB.artifact_id]]);
  expect(withdrawn.map((row) => row.lifecycle_state)).toEqual(["withdrawn", "withdrawn"]);
});

test("rejecting a required output abandons a producer whose only empty slot is optional, so the retry is not refused as work in progress", async () => {
  const setup = await setupMaterializedRun(4, false, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const outputs: readonly MaterializedRunOutput[] = [
    { identity: { kind: "scalar", output_name: "spec" }, artifact_type: "dev.spec", required: true, release: GATE_RELEASE },
    { identity: { kind: "scalar", output_name: "notes" }, artifact_type: "dev.notes", required: false, release: GATE_RELEASE },
  ];
  const fixture = await materializeSingleUnitStage(setup, "author", "writer", outputs);
  const body = { spec: 1 };
  const published = await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: fixture.workOrderId, capability_hash: fixture.capabilityHash,
    output_name: "spec", collection_key: null, body, idempotency_key: "spec-v1", payload_hash: payloadHashOf(body), published_at: fixture.at });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);
  const slots = await sql!.query<{ readonly output_name: string; readonly required: boolean; readonly state: string }>("SELECT output_name, required, state FROM oakridge.run_output_slot WHERE run_unit_id = $1 ORDER BY output_name", [fixture.runUnitId]);
  expect(slots).toEqual([{ output_name: "notes", required: false, state: "empty" }, { output_name: "spec", required: true, state: "pending" }]);

  // The optional slot is still empty, but nothing required is owed: the producer is done.
  await setup.records.close_output_wait({ wait_id: published.wait_id, disposition: "invalidate", actor: "operator:sam", detail: "redo", decided_at: fixture.at });
  const workOrder = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [fixture.workOrderId]);
  expect(workOrder[0]?.state).toBe("abandoned");
  const retry = await setup.records.retry_unit({ target: { kind: "run_unit", run_unit_id: fixture.runUnitId }, idempotency_key: "retry-optional", actor: "operator:sam" }, fixture.at);
  expect(retry.kind).toBe("created");
});
const setupMaterializedRun = async (maxParallel = 1, withDependencies = true, manualAdmission = false): Promise<{ readonly records: PostgresRunRecordRepository; readonly input: PersistMaterializedStage; readonly capabilities: readonly string[] } | null> => {
  if (!sql) return null;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const now = new Date().toISOString();
  await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition,archived,created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `materialized-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const unitIds = ["foundation", "web", "docs"] as const;
  const runUnitIds = unitIds.map(() => randomUUID() as RunUnitId);
  const workOrderIds = unitIds.map(() => randomUUID() as WorkOrderId);
  const capabilities = unitIds.map((unit) => createHash("sha256").update(`secret:${unit}`).digest("hex"));
  const outputs = [{ identity: { kind: "scalar" as const, output_name: "result" }, artifact_type: "dev.result", required: true, release: { kind: "immediate" as const } }];
  const input: PersistMaterializedStage = {
    run_id: runId, stage_instance_id: stageId, stage_key: "build", stage_type: "delegated_session",
    stage_contract: { stage_key: "build" as import("../src/domain/workflow").StageKey, stage_type: "delegated_session" as import("../src/domain/workflow").StageTypeId, operator_role: null,
      inputs: [], outputs: [{ name: "result", artifact_type: "dev.result" as import("../src/domain/workflow").ArtifactTypeId, release: { kind: "immediate" } }],
      materialization: { kind: "scalar" }, executor: { executor_type: "delegated_session", definition_config: {} } },
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
  const base = { ...setup.input, stage_instance_id: stageId, stage_key: "incremental", policy: { ...setup.input.policy, manual_admission: true }, units: [web], close_materialization: false } satisfies PersistMaterializedStage;
  await setup.records.persist_materialized_stage(base);
  // Admission records the fact and nothing else — its dependency ("foundation")
  // has no row yet, and storage no longer refuses on that; eligibility (a
  // pending dependency) is `derive`'s question, proven below by the order
  // staying `available` rather than starting.
  expect(await setup.records.admit_unit({ stage_instance_id: stageId, unit_id: web.unit_id, idempotency_key: "forward-edge" }, base.materialized_at))
    .toEqual({ kind: "admitted", stage_instance_id: stageId, unit_id: web.unit_id });
  await setup.records.decide_run(base.run_id, base.materialized_at);
  expect((await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id=$1", [web.initial_work_order.id]))[0]?.state).toBe("available");
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
  expect(concurrent.flatMap((result) => result.ok && result.value.kind === "recheck" ? result.value.started : [])).toHaveLength(2);
  const started = await sql!.query<{ readonly unit_id: string }>(`SELECT unit.unit_id FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=$1 AND work.state='started'`, [setup.input.run_id]);
  expect(started.map((row) => row.unit_id).sort()).toEqual(["docs", "foundation"]);
});

test("manual admission records the admission fact and is idempotent", async () => {
  const setup = await setupMaterializedRun(2, true, true);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const [foundation, web] = setup.input.units;
  if (!foundation || !web) throw new Error("fixture units missing");
  const admitted = await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: foundation.unit_id, idempotency_key: "foundation-1" }, setup.input.materialized_at);
  expect(admitted.kind).toBe("admitted");
  expect((await setup.records.admit_unit({ stage_instance_id: setup.input.stage_instance_id, unit_id: foundation.unit_id, idempotency_key: "foundation-1" }, setup.input.materialized_at)).kind).toBe("already_admitted");
  // Only foundation is admitted; web (which depends on foundation, itself not
  // yet satisfied) stays unadmitted. `derive` is what reads eligibility now —
  // storage recorded only the one admission fact.
  const decision = await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  expect(decision).toEqual({ ok: true, value: { kind: "recheck", record_version: expect.any(Number), started: [{ id: foundation.initial_work_order.id, run_unit_id: foundation.id }] } });
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

test("a revision reopens a succeeded stage", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const stageSucceeded = async (): Promise<boolean> =>
    (await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.stage_instance WHERE id=$1", [setup.input.stage_instance_id]))[0]?.state === "succeeded";

  // Drive the chain (foundation -> web -> docs) to completion by publishing
  // each unit's required output as its work order starts. Stop asking the
  // instant the stage row closes: this fixture's only stage is also its only
  // definition stage (spec §D), so one ask further would complete the run
  // too — and the point here is a stage the run has already closed out, not
  // a completed run.
  for (const unit of setup.input.units) {
    for (let asks = 0; asks < 10; asks += 1) {
      const decision = await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
      if (!decision.ok) throw new Error(`decide_run failed: ${JSON.stringify(decision)}`);
      if (decision.value.kind !== "recheck") break;
    }
    const order = unit.initial_work_order;
    const body = { unit: unit.unit_id };
    const published = await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: order.id, output_name: "result",
      capability_hash: order.capability_hash, body, idempotency_key: `publish-${unit.unit_id}`, payload_hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), published_at: setup.input.materialized_at });
    expect(published.kind).toBe("published");
  }
  for (let asks = 0; asks < 10 && !(await stageSucceeded()); asks += 1) await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  expect(await stageSucceeded()).toBe(true);
  expect((await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id=$1", [setup.input.run_id]))[0]?.state).toBe("active");

  // Revise "web" — the stage it belongs to is succeeded, and the revision
  // must reopen it.
  const revisedUnit = setup.input.units[1]!;
  const replacementWorkOrderId = randomUUID() as WorkOrderId;
  const revised = await setup.records.revise_unit_input({ run_unit_id: revisedUnit.id, input_snapshot: [], input_fingerprint: "revised" as InputFingerprint,
    revised_at: setup.input.materialized_at, actor: "test", replacement_work_order: {
      ...revisedUnit.initial_work_order, id: replacementWorkOrderId, workflow_id: `v2-work:${replacementWorkOrderId}`,
      request: { ...revisedUnit.initial_work_order.request, execution_id: replacementWorkOrderId as unknown as import("../src/domain/primitives").ExecutionId },
    } });
  expect(revised.kind).toBe("revised");

  const stageRow = (await sql!.query<{ readonly state: string; readonly outcome: unknown }>("SELECT state,outcome FROM oakridge.stage_instance WHERE id=$1", [setup.input.stage_instance_id]))[0];
  expect(stageRow?.state).toBe("active");
  expect(stageRow?.outcome).toBeNull();
  expect((await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.run_unit WHERE id=$1", [revisedUnit.id]))[0]?.state).toBe("ready");

  const nextAsk = await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  expect(nextAsk).toEqual({ ok: true, value: { kind: "recheck", record_version: expect.any(Number), started: [{ id: replacementWorkOrderId, run_unit_id: revisedUnit.id }] } });
});

test("operator retry is idempotent, requires recorded missing work, and preserves released slots", async () => {
  const setup = await setupMaterializedRun(4, false, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const template = setup.input.units[0]!;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const capabilityHash = createHash("sha256").update("retry-capability").digest("hex");
  const outputs = ["kept", "missing"].map((name) => ({ identity: { kind: "scalar" as const, output_name: name }, artifact_type: "dev.result", required: true, release: { kind: "immediate" as const } }));
  const request = { ...template.initial_work_order.request, execution_id: workOrderId as unknown as import("../src/domain/primitives").ExecutionId,
    stage_instance_id: stageId, unit_id: "retry-target" as UnitId,
    resolved_config: { publication: { base_url: "http://oakridge.test", work_order_id: workOrderId, capability: "retry-capability" } },
    declared_outputs: outputs.map((output) => ({ name: output.identity.output_name, artifact_type: output.artifact_type, required: true })),
    expected_artifacts: outputs.map((output) => ({ unit_id: "retry-target" as UnitId, output_name: output.identity.output_name, artifact_type: output.artifact_type })) };
  const stage = { ...setup.input, stage_instance_id: stageId, stage_key: "retry", policy: { max_parallel: 4, manual_admission: false }, units: [{ ...template,
    id: runUnitId, unit_id: "retry-target" as UnitId, depends_on: [], outputs, initial_work_order: { id: workOrderId, workflow_id: `v2-work:${workOrderId}`, capability_hash: capabilityHash, request } }] } satisfies PersistMaterializedStage;
  await setup.records.persist_materialized_stage(stage);
  await setup.records.decide_run(stage.run_id, stage.materialized_at);
  const keptBody = { value: "durable" };
  expect((await setup.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId, capability_hash: capabilityHash,
    output_name: "kept", body: keptBody, idempotency_key: "kept", payload_hash: createHash("sha256").update(JSON.stringify(keptBody)).digest("hex"), published_at: stage.materialized_at })).kind).toBe("published");
  await setup.records.ensure_executor_attachment(workOrderId, request.executor_type, stage.materialized_at);
  await setup.records.observe_executor(workOrderId, { kind: "ended_failed", code: "executor_failed", detail: "boom", observed_at: stage.materialized_at }, stage.materialized_at);
  const retry = await setup.records.retry_unit({ target: { kind: "run_unit", run_unit_id: runUnitId }, idempotency_key: "retry-1", actor: "operator:test" }, stage.materialized_at);
  expect(retry.kind).toBe("created");
  if (retry.kind !== "created") throw new Error(`expected created, got ${retry.kind}`);
  expect(retry.work_order.reason).toBe("operator_retry");
  expect(retry.work_order.workflow_id).toBe(`v2-work:${retry.work_order.id}`);
  // The retry runs under authority minted for itself and owes only what is missing.
  const stored = await storedWorkOrder(retry.work_order.id);
  expect(publicationOf(stored.execution_request).work_order_id).toBe(retry.work_order.id);
  expect(createHash("sha256").update(publicationOf(stored.execution_request).capability).digest("hex")).toBe(stored.capability_hash);
  expect(stored.capability_hash).not.toBe(capabilityHash);
  expect(stored.execution_request.expected_artifacts).toEqual([{ unit_id: "retry-target" as UnitId, output_name: "missing", artifact_type: "dev.result" as never }]);
  expect(await setup.records.retry_unit({ target: { kind: "run_unit", run_unit_id: runUnitId }, idempotency_key: "retry-1", actor: "operator:test" }, stage.materialized_at))
    .toEqual(expect.objectContaining({ kind: "already_created", work_order: expect.objectContaining({ id: retry.work_order.id }) }));
  expect(await setup.records.retry_unit({ target: { kind: "stage_unit", stage_instance_id: stageId, unit_id: "retry-target" as UnitId }, idempotency_key: "retry-2", actor: "operator:test" }, stage.materialized_at))
    .toEqual(expect.objectContaining({ kind: "work_in_progress" }));
  expect(await setup.records.retry_unit({ target: { kind: "stage_unit", stage_instance_id: stageId, unit_id: "no-such-unit" as UnitId }, idempotency_key: "retry-3", actor: "operator:test" }, stage.materialized_at))
    .toEqual(expect.objectContaining({ kind: "unit_not_found" }));
  const slots = await sql!.query<{ readonly output_name: string; readonly state: string }>("SELECT output_name,state FROM oakridge.run_output_slot WHERE run_unit_id=$1 ORDER BY output_name", [runUnitId]);
  expect(slots).toEqual([{ output_name: "kept", state: "released" }, { output_name: "missing", state: "empty" }]);
  const oldOrder = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id=$1", [workOrderId]);
  expect(oldOrder[0]?.state).toBe("abandoned");
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
      output_name: "files", collection_key: key as OutputCollectionKey, body, idempotency_key: "same-key-distinct-member", payload_hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), published_at: second.materialized_at });
    expect(result.kind).toBe("published");
  }
  const artifactUnits = await sql!.query<{ readonly unit_id: string; readonly collection_key: string }>("SELECT unit_id,collection_key FROM oakridge.artifact WHERE work_order_id=$1 ORDER BY collection_key", [order.id]);
  expect(artifactUnits).toEqual([{ unit_id: "a", collection_key: "a" }, { unit_id: "b", collection_key: "b" }]);
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

test("run cancellation atomically terminalizes owned work, waits, units, stages, and the run", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const unit = setup.input.units[0]!;
  await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  const cancelled = await setup.records.cancel_run({ run_id: setup.input.run_id, actor: "operator:test", reason: "stop", cancelled_at: setup.input.materialized_at });
  expect(cancelled).toEqual(expect.objectContaining({ kind: "cancelled", run_id: setup.input.run_id }));
  expect(await setup.records.cancel_run({ run_id: setup.input.run_id, actor: "operator:test", reason: "stop", cancelled_at: setup.input.materialized_at }))
    .toEqual({ kind: "already_terminal", run_id: setup.input.run_id, state: "cancelled" });
  const rows = await sql!.query<{ readonly run_state: string; readonly stage_state: string; readonly unit_state: string; readonly work_state: string }>(
    `SELECT run.state AS run_state,stage.state AS stage_state,unit.state AS unit_state,work.state AS work_state
     FROM oakridge.workflow_run run JOIN oakridge.stage_instance stage ON stage.run_id=run.id
     JOIN oakridge.run_unit unit ON unit.stage_instance_id=stage.id JOIN oakridge.work_order work ON work.run_unit_id=unit.id
     WHERE run.id=$1 AND work.id=$2`, [setup.input.run_id, unit.initial_work_order.id]);
  expect(rows[0]).toEqual({ run_state: "cancelled", stage_state: "cancelled", unit_state: "cancelled", work_state: "abandoned" });
  const transitions = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_transition WHERE run_id=$1 AND operation='run_cancelled'", [setup.input.run_id]);
  expect(transitions[0]?.count).toBe("1");
});

test("cancelling a run parked at a gate closes its open wait as withdrawn, not cancelled", async () => {
  const setup = await setupGatedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const { records, runId, workOrderId, capabilityHash, now } = setup;
  const artifactId = randomUUID() as ArtifactId;
  const body = { plan: "draft" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: artifactId, work_order_id: workOrderId, output_name: "result", body,
    capability_hash: capabilityHash, idempotency_key: "cancel-gate", payload_hash: payloadHash, published_at: now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);

  // Before the fix, cancel_run wrote {kind:"cancelled"} onto every open wait, and the wait
  // table's CHECK constraint (0009: gate waits allow only decided | superseded | withdrawn)
  // rejected it — cancelling a run parked at a gate always failed.
  const cancelled = await records.cancel_run({ run_id: runId, actor: "operator:test", reason: "stop", cancelled_at: now });
  expect(cancelled).toEqual(expect.objectContaining({ kind: "cancelled", run_id: runId }));

  const wait = await sql!.query<{ readonly status: string; readonly kind: string }>(
    "SELECT status, outcome->>'kind' AS kind FROM oakridge.wait WHERE id = $1", [published.wait_id]);
  expect(wait[0]).toEqual({ status: "closed", kind: "withdrawn" });
  const slot = await sql!.query<{ readonly state: string }>(
    "SELECT state FROM oakridge.run_output_slot WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1) AND output_name = 'result'", [workOrderId]);
  expect(slot[0]?.state).toBe("invalidated");
  const run = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [runId]);
  expect(run[0]?.state).toBe("cancelled");
});

test("cancellation serializes with a concurrent artifact publication and cancellation always owns the final state", async () => {
  const setup = await setupMaterializedRun(1, false);
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const unit = setup.input.units[0]!;
  await setup.records.decide_run(setup.input.run_id, setup.input.materialized_at);
  const body = { completed: true };
  const [cancelled, published] = await Promise.all([
    setup.records.cancel_run({ run_id: setup.input.run_id, actor: "operator:test", reason: "stop", cancelled_at: setup.input.materialized_at }),
    new PostgresRunRecordRepository(sql!).publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: unit.initial_work_order.id,
      output_name: "result", body, capability_hash: setup.capabilities[0]!, idempotency_key: "cancel-race",
      payload_hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), published_at: setup.input.materialized_at }),
  ]);
  expect(cancelled.kind).toBe("cancelled");
  expect(["published", "work_abandoned"]).toContain(published.kind);
  const state = await sql!.query<{ readonly run_state: string; readonly unit_state: string; readonly work_state: string; readonly slot_state: string }>(
    `SELECT run.state AS run_state,unit.state AS unit_state,work.state AS work_state,slot.state AS slot_state
     FROM oakridge.workflow_run run JOIN oakridge.run_unit unit ON unit.run_id=run.id
     JOIN oakridge.work_order work ON work.run_unit_id=unit.id JOIN oakridge.run_output_slot slot ON slot.run_unit_id=unit.id
     WHERE run.id=$1 AND work.id=$2`, [setup.input.run_id, unit.initial_work_order.id]);
  expect(state[0]).toEqual({ run_state: "cancelled", unit_state: "cancelled", work_state: "abandoned",
    slot_state: published.kind === "published" ? "released" : "empty" });
});

test("v2 deletion refuses active work and deletes a terminal ownership graph without consulting DBOS", async () => {
  const setup = await setupMaterializedRun();
  if (!setup) { console.warn("run-record PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  expect(await setup.records.delete_run(setup.input.run_id)).toEqual(expect.objectContaining({ kind: "active_conflict" }));
  await setup.records.cancel_run({ run_id: setup.input.run_id, actor: "operator:test", reason: null, cancelled_at: setup.input.materialized_at });
  expect(await setup.records.delete_run(setup.input.run_id)).toEqual({ kind: "deleted", run_id: setup.input.run_id });
  expect(await setup.records.delete_run(setup.input.run_id)).toEqual({ kind: "already_deleted", run_id: setup.input.run_id });
});
