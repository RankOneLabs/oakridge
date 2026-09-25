import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { CohortPullRequestReconciliation } from "../src/domain/cohort-pull-request";
import type { ArtifactId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresCohortPullRequestRepository } from "../src/storage/postgres-policy";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { findTestDatabaseUrl } from "./support/durable-database";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

test("a replacement handoff records its own merge completion after an earlier handoff completed", async () => {
  if (!sql) { console.warn("cohort reconciliation PostgreSQL test SKIPPED: no PostgreSQL reachable"); return; }
  const definitionId = randomUUID();
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const firstArtifactId = randomUUID() as ArtifactId;
  const secondArtifactId = randomUUID() as ArtifactId;
  const unitId = "builder" as UnitId;
  const firstCompletion = "2026-09-24T12:00:00.000Z";
  const secondCompletion = "2026-09-25T12:00:00.000Z";
  await sql.query("INSERT INTO oakridge.workflow_definition (id,name,version,definition,created_at) VALUES ($1,$2,1,'{}'::jsonb,$3::timestamptz)",
    [definitionId, `cohort-reconciliation-${runId}`, firstCompletion]);
  await sql.query("INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)",
    [runId, definitionId, firstCompletion]);
  await sql.query(`INSERT INTO oakridge.stage_instance
    (id,run_id,stage_key,stage_type,stage_contract,coordinator_workflow_id,started_at)
    VALUES ($1,$2,'build','delegated_session','{}'::jsonb,$3,$4::timestamptz)`,
  [stageId, runId, `cohort-reconciliation:${stageId}`, firstCompletion]);
  for (const [artifactId, outputName] of [[firstArtifactId, "first"], [secondArtifactId, "second"]] as const) {
    await sql.query(`INSERT INTO oakridge.artifact
      (id,chain_id,run_id,stage_instance_id,execution_id,unit_id,output_name,artifact_type,body,version,emission_idempotency_key,emission_payload_hash,created_at)
      VALUES ($1,$1,$2,$3,$4,$5,$6,'dev.build_result','{}'::jsonb,1,$6,'hash',$7::timestamptz)`,
    [artifactId, runId, stageId, `work:${outputName}`, unitId, outputName, firstCompletion]);
  }

  const repository = new PostgresCohortPullRequestRepository(sql);
  const reconciliation = (artifactId: ArtifactId, observedAt: string, completedAt: string | null): CohortPullRequestReconciliation => ({
    run_id: runId, stage_instance_id: stageId, unit_id: unitId, repository_key: "scout", handoff_artifact_id: artifactId,
    observation: { provider: "github", owner: "RankOneLabs", name: "scout", number: 47,
      url: "https://github.com/RankOneLabs/scout/pull/47", head_branch: "cohort/builder", base_branch: "epic/jev-integration",
      head_sha: null, state: "merged", source: "poll", observed_at: observedAt, merged_at: firstCompletion },
    mismatch: null, completed_at: completedAt, updated_at: observedAt,
  });
  await repository.upsert(reconciliation(firstArtifactId, "2026-09-24T12:01:00.000Z", firstCompletion));
  await repository.upsert(reconciliation(secondArtifactId, "2026-09-25T11:59:00.000Z", null));
  expect(await repository.find(stageId, unitId)).toEqual(expect.objectContaining({ handoff_artifact_id: secondArtifactId, completed_at: null }));
  await repository.upsert(reconciliation(secondArtifactId, secondCompletion, secondCompletion));
  const completed = await repository.find(stageId, unitId);
  expect(completed?.handoff_artifact_id).toBe(secondArtifactId);
  expect(new Date(completed!.completed_at!).toISOString()).toBe(secondCompletion);
});
