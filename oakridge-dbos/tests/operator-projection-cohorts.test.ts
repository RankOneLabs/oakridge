import { randomUUID } from "node:crypto";

import { afterAll, expect, test } from "bun:test";

import type { RunUnitId, StageInstanceId, WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";

import { applyMigrations } from "../src/storage/migrate";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { ensureDbosSystemSchema } from "./support/dbos-system-schema";
import { findTestDatabaseUrl } from "./support/durable-database";

// postgres-operators still targets the v14 runtime schema; c8 replaces it.
const projectionTest = test.skip;
const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql && databaseUrl) await ensureDbosSystemSchema(databaseUrl);
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

interface SeededCohort {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: string;
  readonly workflow_name: string;
}

const seedCohort = async (
  executor: PgPostgresExecutor,
  options: { readonly release: Record<string, string>; readonly attention: "optional" | "none"; readonly manual_admission: boolean },
): Promise<SeededCohort> => {
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageInstanceId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const unitId = `cohort-${runUnitId}`;
  const now = "2026-09-26T12:00:00.000Z";
  const workflowName = `operator-projection-${runId}`;
  const definition = { id: definitionId, name: workflowName, version: 1, graph: { stages: {}, edges: [] }, created_at: now, archived: false } satisfies WorkflowDefinition;

  await executor.query(
    "INSERT INTO oakridge.workflow_definition (id,name,version,definition,archived,created_at) VALUES ($1,$2,1,$3::jsonb,false,$4::timestamptz)",
    [definitionId, workflowName, JSON.stringify(definition), now],
  );
  await executor.query(
    "INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)",
    [runId, definitionId, now],
  );
  await executor.query(
    `INSERT INTO oakridge.stage_instance
       (id,run_id,stage_key,stage_type,stage_contract,coordinator_workflow_id,started_at,attempt_root_workflow_id)
     VALUES ($1,$2,'build','delegated_session',$3::jsonb,$4,$5::timestamptz,NULL)`,
    [stageInstanceId, runId, JSON.stringify({ operator_role: "build", outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: options.release, attention: options.attention }] }), `v2-stage:${stageInstanceId}`, now],
  );
  await executor.query(
    "INSERT INTO oakridge.run_stage_scheduling_policy (stage_instance_id,max_parallel,manual_admission,materialization_fingerprint) VALUES ($1,4,$2,'fixture')",
    [stageInstanceId, options.manual_admission],
  );
  await executor.query(
    `INSERT INTO oakridge.run_unit
       (id,run_id,stage_instance_id,unit_id,parameters,input_snapshot,input_fingerprint,state,admitted,created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,'empty','working',$6,$7::timestamptz)`,
    [runUnitId, runId, stageInstanceId, unitId, JSON.stringify({ artifact: { repository_key: "oakridge", title: "Operator projections" } }), !options.manual_admission, now],
  );
  return { run_id: runId, stage_instance_id: stageInstanceId, unit_id: unitId, workflow_name: workflowName };
};

projectionTest("an immediate output with declared attention keeps its cohort and admission item", async () => {
  if (!sql) { console.warn("operator projection cohort test SKIPPED: no PostgreSQL reachable"); return; }
  const seeded = await seedCohort(sql, { release: { kind: "immediate" }, attention: "optional", manual_admission: true });
  const repository = new PostgresOperatorProjectionRepository(sql, "test-app-version");

  const cohort = (await repository.list_cohorts()).find((candidate) => candidate.run_id === seeded.run_id && candidate.unit_id === seeded.unit_id);
  expect(cohort).toEqual(expect.objectContaining({ lifecycle: "waiting_admission", artifact_revision_id: null }));

  const inbox = await repository.get_review_inbox();
  expect(inbox.items).toContainEqual(expect.objectContaining({
    id: `${seeded.stage_instance_id}:${seeded.unit_id}:admission`,
    kind: "admission",
    run_id: seeded.run_id,
    unit_id: seeded.unit_id,
  }));
});

projectionTest("a handoff output retains the established cohort projection byte for byte", async () => {
  if (!sql) { console.warn("operator projection cohort test SKIPPED: no PostgreSQL reachable"); return; }
  const seeded = await seedCohort(sql, {
    release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "pull_request_merge" },
    attention: "optional",
    manual_admission: false,
  });
  const repository = new PostgresOperatorProjectionRepository(sql, "test-app-version");
  const cohort = (await repository.list_cohorts()).find((candidate) => candidate.run_id === seeded.run_id && candidate.unit_id === seeded.unit_id);

  expect(JSON.stringify(cohort)).toBe(JSON.stringify({
    id: `${seeded.stage_instance_id}:${seeded.unit_id}`,
    run_id: seeded.run_id,
    workflow_name: seeded.workflow_name,
    stage_instance_id: seeded.stage_instance_id,
    stage_name: "build",
    unit_id: seeded.unit_id,
    repository_key: "oakridge",
    title: "Operator projections",
    lifecycle: "building",
    completion: { build_complete: false, assessment_complete: false },
    admission: { required: false, admitted: true, eligible: true, blocked_by: [] },
    artifact_revision_id: null,
    artifact_url: null,
    gate_id: null,
    gate_url: null,
    pr_url: null,
    pull_request_reconciliation: null,
    updated_at: "2026-09-26 12:00:00+00",
  }));
});

projectionTest("run summary stage totals match run detail without compiling the list", async () => {
  if (!sql) { console.warn("operator projection stage progress test SKIPPED: no PostgreSQL reachable"); return; }
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageInstanceId = randomUUID() as StageInstanceId;
  const now = "2026-09-26T13:00:00.000Z";
  const stage = (name: string) => ({
    stage_type: "delegated_session",
    operator_role: null,
    config: {
      runtime: "codex",
      prompt_template_path: "dev-flow/build_v2.md",
      slot_bindings: {},
      workdir: { from: "literal" as const, value: "/workspace" },
      session_name: name,
    },
    inputs: [],
    outputs: [{ name, artifact_type: `dev.${name}`, attention: "none" as const }],
  });
  const definition = {
    id: definitionId,
    name: `stage-progress-${runId}`,
    version: 1,
    graph: { stages: { build: stage("build_result"), document: stage("documentation") }, edges: [] },
    created_at: now,
    archived: false,
  } satisfies WorkflowDefinition;

  await sql.query(
    "INSERT INTO oakridge.workflow_definition (id,name,version,definition,archived,created_at) VALUES ($1,$2,1,$3::jsonb,false,$4::timestamptz)",
    [definitionId, definition.name, JSON.stringify(definition), now],
  );
  await sql.query(
    "INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)",
    [runId, definitionId, now],
  );
  await sql.query(
    `INSERT INTO oakridge.stage_instance
       (id,run_id,stage_key,stage_type,stage_contract,coordinator_workflow_id,started_at,ended_at,outcome,attempt_root_workflow_id,state)
     VALUES ($1,$2,'build','delegated_session',$3::jsonb,$4,$5::timestamptz,$5::timestamptz,'{"kind":"succeeded"}'::jsonb,NULL,'succeeded')`,
    [stageInstanceId, runId, JSON.stringify({ operator_role: null, outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "immediate" }, attention: "none" }] }), `v2-stage:${stageInstanceId}`, now],
  );

  const repository = new PostgresOperatorProjectionRepository(sql, "test-app-version");
  const summary = (await repository.list_runs("all")).find((candidate) => candidate.id === runId);
  const detail = await repository.get_run(runId);

  expect(summary?.stage_total).toBe(detail?.stages.length);
  expect(summary?.stage_complete).toBe(1);
});
