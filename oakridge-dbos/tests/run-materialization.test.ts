import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { InputFingerprint, RunRecordVersion, RunUnitId, WorkflowRunId } from "../src/domain/primitives";
import type { PersistMaterializedStage, RunMaterializationRecord } from "../src/domain/run-record";
import { reconcileRunMaterialization } from "../src/runtime/run-materialization";
import { loadDevFlowV14 } from "../src/seed/dev-flow-v14";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

test("v2 reconciliation persists the whole stage graph and only source work, idempotently", async () => {
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definition = loaded.value;
  const runId = "10000000-0000-4000-8000-000000000001" as WorkflowRunId;
  let record: RunMaterializationRecord = {
    run: { id: runId, workflow_definition_id: definition.id, workflow_definition_version: definition.version,
      context: { brief_notes: "test", base_branch: "epic/test", repositories: [{ key: "oakridge", path: "/tmp/oakridge", integration_branch: "main" }],
        oakridge_url: "http://oakridge.test", planner_runtime: "claude-code", planner_model: null, planner_effort: null,
        worker_runtime: "claude-code", worker_model: null, worker_effort: null },
      state: "active", outcome: null, record_version: 0 as RunRecordVersion, created_at: "2026-08-29T00:00:00Z", ended_at: null },
    stages: [], available_artifacts: [],
  };
  const persisted: PersistMaterializedStage[] = [];
  const dependencies = {
    definitions: { async find_by_id() { return definition; } },
    records: {
      async load_materialization_record() { return record; },
      async load_work_order_capability_seed() { return "test-capability-seed-that-is-long-enough"; },
      async persist_materialized_stage(input: PersistMaterializedStage) {
        persisted.push(input);
        const current = record.stages.find((stage) => stage.stage_key === input.stage_key);
        const additions = input.units.map((unit) => ({ id: unit.id, unit_id: unit.unit_id, input_fingerprint: unit.input_fingerprint, state: "ready" as const }));
        const next = { id: input.stage_instance_id, stage_key: input.stage_key, state: "active" as const,
          materialization_closed: current?.materialization_closed || input.close_materialization,
          units: [...(current?.units ?? []), ...additions.filter((unit) => !current?.units.some((candidate) => candidate.unit_id === unit.unit_id))] };
        record = { ...record, stages: [...record.stages.filter((stage) => stage.stage_key !== input.stage_key), next] };
      },
      async revise_unit_input() { throw new Error("initial materialization must not revise a unit"); },
      async find_work_order_attachment() { return null; },
    },
    load_prompt_template: (path: string) => Bun.file(resolve(import.meta.dir, "../../oakridge-core/prompts", path)).text(),
  };

  expect((await reconcileRunMaterialization(runId, "2026-08-29T00:00:00Z", dependencies)).ok).toBe(true);
  expect(new Set(persisted.map((stage) => stage.stage_key))).toEqual(new Set(Object.keys(definition.graph.stages)));
  const sourceUnits = persisted.flatMap((stage) => stage.units);
  expect(sourceUnits.length).toBeGreaterThan(0);
  expect(sourceUnits.every((unit) => unit.initial_work_order.workflow_id === `v2-work:${unit.initial_work_order.id}`)).toBe(true);

  const provision = record.stages.find((stage) => stage.stage_key === "provision_refs");
  if (!provision?.units[0]) throw new Error("provisioning source unit was not materialized");
  record = { ...record,
    stages: record.stages.map((stage) => stage.stage_key === provision.stage_key ? { ...stage, materialization_closed: true,
      units: stage.units.map((unit) => ({ ...unit, state: "satisfied" as const })) } : stage),
    available_artifacts: [{ artifact_id: "20000000-0000-4000-8000-000000000001" as never, chain_id: "20000000-0000-4000-8000-000000000001" as never,
      producer_stage_key: provision.stage_key, producer_execution_id: "30000000-0000-4000-8000-000000000001" as never,
      unit_id: "oakridge" as never, output_name: "repository_refs", artifact_type: "dev.repository_refs",
      body: { repository_key: "oakridge", repository_path: "/tmp/oakridge", integration_branch: "main", base_branch: "epic/test", base_head_sha: "abc" } }],
  };
  persisted.length = 0;
  expect((await reconcileRunMaterialization(runId, "2026-08-29T00:00:01Z", dependencies)).ok).toBe(true);
  const delegated = persisted.flatMap((stage) => stage.units).find((unit) => unit.initial_work_order.request.executor_type === "delegated_session");
  expect((delegated?.initial_work_order.request.resolved_config as { readonly publication?: unknown }).publication).toEqual(expect.objectContaining({ base_url: "http://oakridge.test" }));

  persisted.length = 0;
  expect((await reconcileRunMaterialization(runId, "2026-08-29T00:00:02Z", dependencies)).ok).toBe(true);
  expect(persisted.flatMap((stage) => stage.units)).toEqual([]);
  expect(record.stages.every((stage) => stage.id && stage.units.every((unit) => unit.id as RunUnitId && unit.input_fingerprint as InputFingerprint))).toBe(true);
});

test("PostgreSQL reconciliation persists deterministic source work once", async () => {
  if (!sql) return console.warn("run materialization PostgreSQL test SKIPPED: no PostgreSQL reachable");
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const definitions = new PostgresWorkflowDefinitionRepository(sql);
  await definitions.insert_immutable(loaded.value);
  const runId = randomUUID() as WorkflowRunId;
  await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,$3::jsonb,now())`, [runId, loaded.value.id,
    { brief_notes: "test", base_branch: "epic/test", repositories: [{ key: "oakridge", path: "/tmp/oakridge", integration_branch: "main" }],
      oakridge_url: "http://oakridge.test", planner_runtime: "claude-code", planner_model: null, planner_effort: null,
      worker_runtime: "claude-code", worker_model: null, worker_effort: null }]);
  const records = new PostgresRunRecordRepository(sql);
  const dependencies = { definitions, records, load_prompt_template: (path: string) => Bun.file(resolve(import.meta.dir, "../../oakridge-core/prompts", path)).text() };
  expect((await reconcileRunMaterialization(runId, new Date().toISOString(), dependencies)).ok).toBe(true);
  const first = await sql.query<{ readonly stages: string; readonly units: string; readonly orders: string }>(`SELECT
    (SELECT count(*)::text FROM oakridge.stage_instance WHERE run_id=$1 AND attempt_root_workflow_id IS NULL) AS stages,
    (SELECT count(*)::text FROM oakridge.run_unit WHERE run_id=$1) AS units,
    (SELECT count(*)::text FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=$1) AS orders`, [runId]);
  expect(Number(first[0]?.stages)).toBe(Object.keys(loaded.value.graph.stages).length);
  expect(first[0]?.units).toBe("1");
  expect(first[0]?.orders).toBe("1");
  expect((await reconcileRunMaterialization(runId, new Date().toISOString(), dependencies)).ok).toBe(true);
  const replay = await sql.query<{ readonly units: string; readonly orders: string }>(`SELECT
    (SELECT count(*)::text FROM oakridge.run_unit WHERE run_id=$1) AS units,
    (SELECT count(*)::text FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=$1) AS orders`, [runId]);
  expect(replay[0]).toEqual({ units: "1", orders: "1" });
});
