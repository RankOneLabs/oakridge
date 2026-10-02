import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";

import { resolveCohortRoster } from "../src/adapters/cohort-roster";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { ArtifactId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase } from "./support/durable-database";

// Use the shipped definition and roster resolver: hand-written flat parameters
// hid the extra artifact envelope stored by openStageCohortsStep.
test("persisted fan-out identity reaches gates, inbox, cohorts and run detail", async () => {
  const scratch = await createScratchDatabase("oakridge_projection_identity_test");
  if (!scratch.ok) throw new Error(scratch.error.detail);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    const loaded = await loadDevFlowV15();
    if (!loaded.ok) throw new Error(loaded.error.detail);
    const compiled = compileWorkflowDefinition(loaded.value);
    if (!compiled.ok) throw new Error(compiled.error.detail);
    const build = compiled.value.stages.build;
    if (!build) throw new Error("build stage missing");
    const input: ArtifactEnvelope = { artifact_id: randomUUID() as ArtifactId, artifact_type: "dev.build_brief",
      output_name: "brief", unit_id: "api" as UnitId,
      body: { repository_key: "pipefitter", title: "Build API", depends_on: [] } };
    const [entry] = resolveCohortRoster(build, {}, { brief: [input] });
    if (!entry) throw new Error("build roster missing");
    const params = { unit_id: entry.cohort_key, artifact: entry.item };
    const runId = randomUUID() as WorkflowRunId;
    const stageId = randomUUID() as StageInstanceId;
    const cohortId = randomUUID();
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ($1,$2,$3,$4)`, [loaded.value.id, loaded.value.name, loaded.value.version, JSON.stringify(loaded.value)]);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ($1,$2,'{}','{}','active')`, [runId, loaded.value.id]);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,$2,'build','delegated_session',$3,'active')`, [stageId, runId, JSON.stringify(build)]);
    await sql.query(`INSERT INTO oakridge.cohort
      (id,run_id,stage_instance_id,cohort_key,state,status,blocked_reason,next_actor,stage_data)
      VALUES ($1,$2,$3,$4,'build_review','blocked','gate','operator',$5)`,
      [cohortId, runId, stageId, entry.cohort_key, JSON.stringify(params)]);
    await sql.query(`INSERT INTO oakridge.wait_gate
      (id,run_id,stage_instance_id,cohort_id,kind,closes_on,command_workflow_id)
      VALUES ($1,$2,$3,$4,'gate','{"gate_step":"artifact_approval","actions":["approve"]}','identity-gate')`,
      [randomUUID(), runId, stageId, cohortId]);
    const repository = new PostgresOperatorProjectionRepository(sql, "test", createDevFlowAdapterRegistry());
    const gates = await repository.list_pending_gates(runId);
    const cohorts = await repository.list_cohorts();
    const run = await repository.get_run(runId);
    const inbox = await repository.get_review_inbox();
    expect({ gate: gates[0]?.repository_key, cohort: cohorts[0]?.repository_key,
      title: cohorts[0]?.title, unit: run?.stages.find(stage => stage.stage_instance_id === stageId)?.units[0]?.repository_key,
      inbox: inbox.items[0]?.repository_key }).toEqual({
      gate: "pipefitter", cohort: "pipefitter", title: "Build API", unit: "pipefitter", inbox: "pipefitter",
    });
    // Scalar cohorts have no fan-out item and must continue to report absence.
    await sql.query("UPDATE oakridge.cohort SET stage_data='{\"unit_id\":\"0\",\"artifact\":null}' WHERE id=$1", [cohortId]);
    expect((await repository.list_pending_gates(runId))[0]?.repository_key).toBeNull();
  } finally {
    await sql.close();
    await scratch.value.drop();
  }
}, 30_000);
