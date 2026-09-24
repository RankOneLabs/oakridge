/**
 * `get_run`'s artifact projection filters on "some slot points at this
 * artifact" in *any* slot state, rather than on `effectiveArtifactPredicate`'s
 * narrower `pending`/`released`. That looks like an oversight and has been
 * reported as one; it is not.
 *
 * The two predicates answer different questions. `effectiveArtifactPredicate`
 * answers "what may a downstream consume", where an invalidated slot must yield
 * nothing — that is the whole point of invalidating it. This projection answers
 * "what can the operator open", and a draft sent back for corrections is
 * precisely the thing the operator most needs to reach: it has no consumer, but
 * it is the subject of the correction they are about to request.
 *
 * `operator-run-record-endpoint.test.ts` pins that through the real gate path
 * ("Requesting corrections must not erase the operator's route back to the
 * draft"). This file states the invariant directly against the projection, so
 * the next reader who is tempted to "tighten" the predicate finds the answer at
 * the query rather than inside an endpoint test's fifth assertion.
 */
import { randomUUID } from "node:crypto";

import { afterAll, expect, test } from "bun:test";

import type { RunUnitId, StageInstanceId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { ensureDbosSystemSchema } from "./support/dbos-system-schema";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
// `get_run` folds in run-record detail, which LEFT JOINs `dbos.workflow_status`
// — a schema the SDK creates at launch, not one `applyMigrations` owns.
if (sql && databaseUrl) await ensureDbosSystemSchema(databaseUrl);
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

type SeededSlotState = "released" | "invalidated" | "empty";

interface SeededOutput {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly artifact_id: string;
}

/**
 * One run holding one unit with one published artifact, and its slot left in
 * `slotState`. An `empty` slot models an artifact no slot points at; the
 * artifact row itself is identical in all three cases, which is what makes this
 * a test of the slot filter rather than of the artifact's own lifecycle.
 */
const seedOutput = async (executor: PgPostgresExecutor, slotState: SeededSlotState): Promise<SeededOutput> => {
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageInstanceId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const artifactId = randomUUID();
  const now = new Date().toISOString();
  const definitionName = `run-detail-artifact-visibility-${runId}`;

  const definitionBody = { id: definitionId, name: definitionName, version: 1, graph: { stages: {}, edges: [] }, created_at: now, archived: false } satisfies WorkflowDefinition;
  await executor.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,$3::jsonb,false,$4::timestamptz)`, [definitionId, definitionName, JSON.stringify(definitionBody), now]);
  await executor.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  await executor.query(
    `INSERT INTO oakridge.stage_instance (id, run_id, stage_key, stage_type, stage_contract, coordinator_workflow_id, started_at, attempt_root_workflow_id)
     VALUES ($1, $2, 'build', 'delegated_session', $3::jsonb, $4, $5::timestamptz, NULL)`,
    [stageInstanceId, runId, JSON.stringify({
      operator_role: "build",
      outputs: [{ name: "build_result", release: { kind: "immediate" } }],
    }), `v2-stage:${stageInstanceId}`, now],
  );
  await executor.query(
    `INSERT INTO oakridge.run_stage_scheduling_policy (stage_instance_id, max_parallel, manual_admission, materialization_fingerprint) VALUES ($1, 4, false, 'fp-1')`,
    [stageInstanceId],
  );
  await executor.query(
    `INSERT INTO oakridge.run_unit (id, run_id, stage_instance_id, unit_id, parameters, input_snapshot, input_fingerprint, state, created_at)
     VALUES ($1, $2, $3, '0', '{}'::jsonb, '[]'::jsonb, 'empty', 'working', $4::timestamptz)`,
    [runUnitId, runId, stageInstanceId, now],
  );
  await executor.query(
    `INSERT INTO oakridge.artifact
       (id, chain_id, run_id, stage_instance_id, execution_id, unit_id, output_name, collection_key, artifact_type, body, label, version,
        emission_idempotency_key, emission_payload_hash, created_at, lifecycle_state, lifecycle_updated_at)
     VALUES ($1,$1,$2,$3,$4,'0','build_result',NULL,'dev.build_result','{}'::jsonb,NULL,1,$5,$6,$7::timestamptz,'current',$7::timestamptz)`,
    [artifactId, runId, stageInstanceId, `exec-${artifactId}`, `key-${artifactId}`, `hash-${artifactId}`, now],
  );
  await executor.query(
    `INSERT INTO oakridge.run_output_slot
       (run_unit_id, output_name, artifact_type, required, state, artifact_revision_id, invalidation_reason, state_changed_at, version, release_policy)
     VALUES ($1,'build_result','dev.build_result',true,$2,$3,$4::jsonb,$5::timestamptz,1,'{"kind":"immediate"}'::jsonb)`,
    [runUnitId, slotState,
      slotState === "empty" ? null : artifactId,
      slotState === "invalidated" ? JSON.stringify({ kind: "gate", detail: "rejected at review" }) : null,
      now],
  );

  return { run_id: runId, stage_instance_id: stageInstanceId, artifact_id: artifactId };
};

const projectedArtifactIds = async (executor: PgPostgresExecutor, seeded: SeededOutput): Promise<string[]> => {
  const detail = await new PostgresOperatorProjectionRepository(executor, "test-app-version").get_run(seeded.run_id);
  const stage = detail?.stages.find((candidate) => candidate.stage_instance_id === seeded.stage_instance_id);
  return (stage?.artifacts ?? []).map((artifact) => artifact.id);
};

test("run detail keeps a sent-back draft reachable while its slot is invalidated", async () => {
  if (!sql) { console.warn("run-detail artifact visibility test SKIPPED: no PostgreSQL reachable"); return; }

  const seeded = await seedOutput(sql, "invalidated");
  expect(await projectedArtifactIds(sql, seeded)).toEqual([seeded.artifact_id]);
});

test("run detail reports the artifact a released slot points at", async () => {
  if (!sql) { console.warn("run-detail artifact visibility test SKIPPED: no PostgreSQL reachable"); return; }

  const seeded = await seedOutput(sql, "released");
  expect(await projectedArtifactIds(sql, seeded)).toEqual([seeded.artifact_id]);
});

/** The slot pointer still does real work: an artifact no slot names stays out. */
test("run detail omits an artifact no slot points at", async () => {
  if (!sql) { console.warn("run-detail artifact visibility test SKIPPED: no PostgreSQL reachable"); return; }

  const seeded = await seedOutput(sql, "empty");
  expect(await projectedArtifactIds(sql, seeded)).toEqual([]);
});
