/**
 * The v2 run-record projection, wired into the operator's existing run-detail
 * HTTP response (`GET /runs/:id`) rather than a parallel endpoint. This test
 * drives that route over real HTTP, against a real Postgres-backed
 * repository, and checks every field the acceptance criteria name: current
 * domain decision, slots, waits, work orders with executor health/cleanup,
 * DBOS liveness metadata, and prior/resulting record versions.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import type { ArtifactId, InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { createOperatorProjectionApp } from "../src/http/operator-projections";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

test("GET /runs/:id exposes the v2 run-record projection with every required field", async () => {
  if (!sql) { console.warn("operator run-record endpoint test SKIPPED: no PostgreSQL reachable"); return; }

  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  // Each unit gets its own stage instance: `initialize_straight_through`
  // stores one unit's output contract as its stage's whole contract, so two
  // units sharing a stage id with different outputs collide on the
  // immutable-match check rather than fanning out under one stage.
  const runningStageId = randomUUID() as StageInstanceId;
  const gatedStageId = randomUUID() as StageInstanceId;
  const now = new Date().toISOString();
  const definitionName = `operator-endpoint-${runId}`;
  // A full, self-describing definition — not just `{graph:...}` — because this
  // route (`get_run_record_detail`, spec §3.6) parses the stored definition in
  // full to synthesize `pending` entries for stages with no row yet, not only
  // compiles it the way `decide_run` does.
  const definitionBody = { id: definitionId, name: definitionName, version: 1, graph: { stages: {}, edges: [] }, created_at: now, archived: false } satisfies WorkflowDefinition;
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,$3::jsonb,false,$4::timestamptz)`, [definitionId, definitionName, JSON.stringify(definitionBody), now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  // `get_run`'s v1 summary query still inner-joins an attempt and its DBOS
  // status row — the old topology remains the only public launch path, so a
  // real launch always creates one alongside whatever v2 units live under it.
  const rootWorkflowId = `root-${runId}`;
  await sql.query(`INSERT INTO oakridge.workflow_attempt (root_workflow_id, run_id) VALUES ($1,$2)`, [rootWorkflowId, runId]);
  await sql.query(`INSERT INTO dbos.workflow_status (workflow_uuid, status, name, application_version, executor_id, created_at, updated_at)
    VALUES ($1,'PENDING','oakridgeV2RunWorkflow','test','test-executor', (extract(epoch FROM now())*1000)::bigint, (extract(epoch FROM now())*1000)::bigint)`, [rootWorkflowId]);

  const records = new PostgresRunRecordRepository(sql);

  // Unit 1: immediate release, its work order attached and observed running —
  // exercises decision "work_in_progress" plus executor health/liveness.
  const runningUnitId = randomUUID() as RunUnitId;
  const runningWorkOrderId = randomUUID() as WorkOrderId;
  const runningCapability = createHash("sha256").update(`running-${runningWorkOrderId}`).digest("hex");
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: runningStageId, run_unit_id: runningUnitId, unit_id: "unit-running" as UnitId,
    work_order_id: runningWorkOrderId, work_order_workflow_id: `v2-work:${runningWorkOrderId}`, stage_key: "build-running", executor_type: "delegated_session",
    work_order_capability_hash: runningCapability, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    created_at: now,
  });
  await records.decide_run(runId, now);
  await records.ensure_executor_attachment(runningWorkOrderId, "delegated_session", now);
  await records.observe_executor(runningWorkOrderId, { kind: "running", observed_at: now }, now);

  // Unit 2: gated release, published and still pending on its wait —
  // exercises decision "waiting" and a real open wait row.
  const gatedUnitId = randomUUID() as RunUnitId;
  const gatedWorkOrderId = randomUUID() as WorkOrderId;
  const gatedCapability = createHash("sha256").update(`gated-${gatedWorkOrderId}`).digest("hex");
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: gatedStageId, run_unit_id: gatedUnitId, unit_id: "unit-gated" as UnitId,
    work_order_id: gatedWorkOrderId, work_order_workflow_id: `v2-work:${gatedWorkOrderId}`, stage_key: "build-gated", executor_type: "delegated_session",
    work_order_capability_hash: gatedCapability, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "plan", artifact_type: "dev.plan", required: true,
      release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" } }],
    created_at: now,
  });
  await records.decide_run(runId, now);
  const body = { plan: "draft" };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const published = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: gatedWorkOrderId, output_name: "plan",
    body, capability_hash: gatedCapability, idempotency_key: "endpoint-test-plan-1", payload_hash: payloadHash, published_at: now });
  if (published.kind !== "pending") throw new Error(`expected pending, got ${published.kind}`);

  const app = createOperatorProjectionApp(new PostgresOperatorProjectionRepository(sql));
  const response = await app.request(`/runs/${runId}`);
  expect(response.status).toBe(200);
  interface RunRecordResponsePayload { readonly run_record: RunRecordPayload }
  interface RunRecordPayload {
    readonly run_id: string; readonly state: string; readonly record_version: number;
    readonly units: readonly {
      readonly run_unit_id: string; readonly unit_id: string; readonly decision: string;
      readonly slots: readonly { readonly output_name: string; readonly artifact_type: string; readonly required: boolean; readonly state: string; readonly artifact_revision_id: string | null; readonly version: number }[];
      readonly waits: readonly { readonly id: string; readonly output_name: string | null; readonly kind: string; readonly status: string; readonly opened_at: string }[];
      readonly work_orders: readonly { readonly id: string; readonly reason: string; readonly state: string; readonly workflow_id: string; readonly executor_health: unknown; readonly cleanup_state: string | null; readonly dbos_liveness: string | null }[];
    }[];
    readonly recent_transitions: readonly { readonly operation: string; readonly actor: string; readonly prior_record_version: number; readonly resulting_record_version: number; readonly created_at: string }[];
  }
  const detail = (await response.json()) as RunRecordResponsePayload;
  const runRecord = detail.run_record;

  expect(runRecord.run_id).toBe(runId);
  expect(runRecord.state).toBe("active");
  expect(typeof runRecord.record_version).toBe("number");
  expect(runRecord.units).toHaveLength(2);

  const running = runRecord.units.find((unit) => unit.unit_id === "unit-running");
  expect(running).toEqual(expect.objectContaining({
    run_unit_id: runningUnitId, decision: "work_in_progress",
    slots: [expect.objectContaining({ output_name: "result", artifact_type: "dev.result", required: true, state: "empty", artifact_revision_id: null })],
    waits: [],
  }));
  expect(running?.work_orders).toEqual([expect.objectContaining({
    id: runningWorkOrderId, reason: "initial", state: "started", workflow_id: `v2-work:${runningWorkOrderId}`,
    executor_health: expect.objectContaining({ kind: "running" }), cleanup_state: "not_needed",
  })]);
  // DBOS liveness is read for diagnostics only — no workflow was ever
  // launched for this work order in this test, so it is absent, not guessed.
  expect(running?.work_orders[0]?.dbos_liveness ?? null).toBeNull();

  const gated = runRecord.units.find((unit) => unit.unit_id === "unit-gated");
  expect(gated).toEqual(expect.objectContaining({ run_unit_id: gatedUnitId, decision: "waiting" }));
  expect(gated?.slots).toEqual([expect.objectContaining({ output_name: "plan", state: "pending", artifact_revision_id: published.artifact_id })]);
  expect(gated?.waits).toEqual([expect.objectContaining({ id: published.wait_id, output_name: "plan", kind: "gate", status: "open" })]);

  expect(runRecord.recent_transitions.length).toBeGreaterThan(0);
  for (const transition of runRecord.recent_transitions) {
    expect(typeof transition.operation).toBe("string");
    expect(typeof transition.actor).toBe("string");
    expect(transition.resulting_record_version).toBeGreaterThanOrEqual(transition.prior_record_version);
  }
  expect(runRecord.recent_transitions.some((transition) => transition.operation === "slot_pending")).toBe(true);

  const gates = await (await app.request(`/runs/${runId}/gates`)).json() as readonly { readonly id: string; readonly stage_instance_id: string; readonly artifact_revision_id: string }[];
  expect(gates).toEqual([expect.objectContaining({ id: published.wait_id, stage_instance_id: gatedStageId, artifact_revision_id: published.artifact_id })]);
  const summary = (await (await app.request("/runs?filter=all")).json() as readonly { readonly id: string; readonly status: string; readonly parked_count: number }[])
    .find((candidate) => candidate.id === runId);
  expect(summary).toEqual(expect.objectContaining({ status: "parked", parked_count: 1 }));
  const inbox = await (await app.request("/review_inbox")).json() as { readonly items: readonly { readonly gate_id: string; readonly stage_instance_id: string }[] };
  expect(inbox.items.find((item) => item.gate_id === published.wait_id))
    .toEqual(expect.objectContaining({ gate_id: published.wait_id, stage_instance_id: gatedStageId }));
});

/**
 * A run with no v2 `run_unit` rows is still running entirely under the old
 * topology. Driving this through the full v1 `get_run` HTTP path would also
 * require standing up a `dbos.workflow_status` row that path inner-joins on
 * — real DBOS-provisioned state this file has no business faking — so this
 * checks the v2 projection directly, which is the part Slice 3 owns.
 */
test("get_run_record_detail on a run with no v2 units projects an empty unit list", async () => {
  if (!sql) { console.warn("operator run-record endpoint test SKIPPED: no PostgreSQL reachable"); return; }
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const now = new Date().toISOString();
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{}'::jsonb,false,$3::timestamptz)`, [definitionId, `operator-endpoint-legacy-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);

  const detail = await new PostgresOperatorProjectionRepository(sql).get_run_record_detail(runId);
  expect(detail).toEqual(expect.objectContaining({ run_id: runId, units: [] }));
});
