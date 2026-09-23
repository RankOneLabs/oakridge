/**
 * `get_run`'s stage-unit projection (`postgres-operators.ts:358`) used to
 * hardcode `repository_key: null`, while the cohort projection derived it
 * from the same minted `{unit_id, artifact}` fan-out item
 * (`postgres-operators.ts:494`, then ~500). Both now go through one named
 * helper, `selectStageUnitRepositoryKey`, so a build unit's run detail
 * agrees with what the cohort projection already reported for it.
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
// `get_run` folds in the run-record detail, which LEFT JOINs
// `dbos.workflow_status` — a schema the SDK creates at launch, not one
// `applyMigrations` owns. Without this the test passes on any database some
// earlier launch prepared (every local run, since `oakridge_e2e` persists) and
// fails on CI's fresh one whenever no DBOS-launching file happened to run
// first.
if (sql && databaseUrl) await ensureDbosSystemSchema(databaseUrl);
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

test("a build unit's repository_key on run detail matches the cohort projection", async () => {
  if (!sql) { console.warn("run-detail repository_key test SKIPPED: no PostgreSQL reachable"); return; }

  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageInstanceId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const now = new Date().toISOString();
  const definitionName = `run-detail-repo-key-${runId}`;

  const definitionBody = { id: definitionId, name: definitionName, version: 1, graph: { stages: {}, edges: [] }, created_at: now, archived: false } satisfies WorkflowDefinition;
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,$3::jsonb,false,$4::timestamptz)`, [definitionId, definitionName, JSON.stringify(definitionBody), now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  await sql.query(
    `INSERT INTO oakridge.stage_instance (id, run_id, stage_key, stage_type, stage_contract, coordinator_workflow_id, started_at, attempt_root_workflow_id)
     VALUES ($1, $2, 'build', 'delegated_session', $3::jsonb, $4, $5::timestamptz, NULL)`,
    [stageInstanceId, runId, JSON.stringify({
      operator_role: "build",
      outputs: [{ name: "build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }],
    }), `v2-stage:${stageInstanceId}`, now],
  );
  await sql.query(
    `INSERT INTO oakridge.run_stage_scheduling_policy (stage_instance_id, max_parallel, manual_admission, materialization_fingerprint) VALUES ($1, 4, false, 'fp-1')`,
    [stageInstanceId],
  );
  const cohortParams = { unit_id: "targets_spec_contract", artifact: { repository_key: "pipefitter", title: "Targets spec contract" } };
  await sql.query(
    `INSERT INTO oakridge.run_unit (id, run_id, stage_instance_id, unit_id, parameters, input_snapshot, input_fingerprint, state, created_at)
     VALUES ($1, $2, $3, 'targets_spec_contract', $4::jsonb, '[]'::jsonb, 'empty', 'working', $5::timestamptz)`,
    [runUnitId, runId, stageInstanceId, JSON.stringify(cohortParams), now],
  );

  const repository = new PostgresOperatorProjectionRepository(sql, "test-app-version");
  const detail = await repository.get_run(runId);
  const unit = detail?.stages.find((stage) => stage.stage_instance_id === stageInstanceId)?.units.find((candidate) => candidate.unit_id === "targets_spec_contract");
  expect(unit?.repository_key).toBe("pipefitter");

  const cohorts = await repository.list_cohorts();
  const cohort = cohorts.find((candidate) => candidate.stage_instance_id === stageInstanceId && candidate.unit_id === "targets_spec_contract");
  expect(cohort?.repository_key).toBe(unit?.repository_key);
});
