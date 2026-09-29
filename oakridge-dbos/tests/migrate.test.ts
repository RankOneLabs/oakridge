import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { applyMigrations, migrationNames } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { PostgresDevFlowPullRequestRepository } from "../src/storage/postgres-operators";
import type { CohortId } from "../src/domain/primitives";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const MIGRATIONS = new URL("../src/storage/migrations", import.meta.url).pathname;
const BASELINE = "0015_v15_baseline.sql";
const DEV_FLOW_PULL_REQUESTS = "0016_dev_flow_pull_requests.sql";
const ARTIFACT_THREADS = "0017_artifact_threads_and_attempt_idempotency.sql";
const MIGRATION_SET = [BASELINE, DEV_FLOW_PULL_REQUESTS, ARTIFACT_THREADS];

test("adapter migrations follow the v15 baseline", async () => {
  expect(migrationNames(await readdir(MIGRATIONS))).toEqual(MIGRATION_SET);
});

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

test("v15 baseline represents import artifacts, multi-slot gates, messages, and owner-local versions", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_baseline_test");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("v15 baseline PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    expect(await applyMigrations(sql)).toEqual(MIGRATION_SET);
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8000-000000000001','v15-test',15,'{}')`, []);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','{}',
        '{"definition_version":15,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, []);
    for (const [id, key] of [
      ["00000000-0000-4000-8000-000000000003", "build"],
      ["00000000-0000-4000-8000-000000000004", "assess"],
    ] as const) await sql.query(`INSERT INTO oakridge.stage_instance
      (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ($1,'00000000-0000-4000-8000-000000000002',$2,'test','{}','active')`, [id, key]);
    await sql.query(`INSERT INTO oakridge.cohort
      (id,run_id,stage_instance_id,cohort_key,status,stage_data)
      VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','core','active','{"version":1}')`, []);
    const cohortId = "00000000-0000-4000-8000-000000000005" as CohortId;
    const pullRequests = new PostgresDevFlowPullRequestRepository(sql);
    await pullRequests.create_cohort({ cohort_id: cohortId,
      stage_instance_id: "00000000-0000-4000-8000-000000000003" as import("../src/domain/primitives").StageInstanceId,
      cohort_key: "core", repository_key: "oakridge", repository_path: "/repo/oakridge", canonical_ref: "cohort/core",
      expected_pr_base: "epic/oakridge", recorded_head_sha: "head-one", current_verified_pull_request_id: null,
      created_at: "2026-09-29T09:00:00Z", updated_at: "2026-09-29T09:00:00Z" });
    await sql.query(`INSERT INTO oakridge.cohort
      (id,run_id,stage_instance_id,cohort_key,status,stage_data)
      VALUES ('00000000-0000-4000-8000-000000000055','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','web','active','{}')`, []);
    await pullRequests.create_cohort({ cohort_id: "00000000-0000-4000-8000-000000000055" as CohortId,
      stage_instance_id: "00000000-0000-4000-8000-000000000003" as import("../src/domain/primitives").StageInstanceId,
      cohort_key: "web", repository_key: "web", repository_path: "/repo/web", canonical_ref: "cohort/web",
      expected_pr_base: "release/web", recorded_head_sha: "head-web", current_verified_pull_request_id: null,
      created_at: "2026-09-29T09:00:00Z", updated_at: "2026-09-29T09:00:00Z" });
    expect(await sql.query<{ readonly repository_key: string; readonly expected_pr_base: string }>(
      "SELECT repository_key,expected_pr_base FROM oakridge.dev_flow_build_cohort ORDER BY cohort_key", []))
      .toEqual([{ repository_key: "oakridge", expected_pr_base: "epic/oakridge" }, { repository_key: "web", expected_pr_base: "release/web" }]);

    const observed = (head_sha: string) => ({ provider: "github" as const, owner: "RankOneLabs", name: "oakridge", number: 42,
      url: "https://github.com/RankOneLabs/oakridge/pull/42", head_branch: "cohort/core", base_branch: "epic/oakridge",
      head_sha, state: "open" as const, source: "poll" as const, observed_at: "2026-09-29T10:00:00Z", merged_at: null });
    const firstObservation = await pullRequests.observe({ observation: observed("head-one"), recorded_at: "2026-09-29T10:00:01Z" });
    const firstBinding = await pullRequests.bind_verified({ cohort_id: cohortId, ...firstObservation, verified_head_sha: "head-one",
      verified_at: "2026-09-29T10:00:02Z", replace_verification_id: null });
    expect(firstBinding.ok).toBe(true);
    if (!firstBinding.ok) throw new Error(firstBinding.error.detail);
    await sql.query(`INSERT INTO oakridge.pull_request_approval (id,cohort_id,verification_id,approval_kind,approved_at)
      VALUES ('00000000-0000-4000-8000-000000000060',$1,$2,'assessment_review','2026-09-29T10:00:03Z')`, [cohortId, firstBinding.value]);
    const replacementObservation = { ...observed("head-two"), number: 43, url: "https://github.com/RankOneLabs/oakridge/pull/43" };
    const secondObservation = await pullRequests.observe({ observation: replacementObservation, recorded_at: "2026-09-29T11:00:01Z" });
    expect((await pullRequests.bind_verified({ cohort_id: cohortId, ...secondObservation, verified_head_sha: "head-two",
      verified_at: "2026-09-29T11:00:02Z", replace_verification_id: null })).ok).toBe(false);
    const replacement = await pullRequests.bind_verified({ cohort_id: cohortId, ...secondObservation, verified_head_sha: "head-two",
      verified_at: "2026-09-29T11:00:02Z", replace_verification_id: firstBinding.value });
    expect(replacement.ok).toBe(true);
    await pullRequests.observe({ observation: { ...replacementObservation, state: "merged",
      observed_at: "2026-09-29T12:00:00Z", merged_at: "2026-09-29T12:00:00Z" }, recorded_at: "2026-09-29T12:00:01Z" });
    expect((await pullRequests.find_current_for_unit(
      "00000000-0000-4000-8000-000000000003" as import("../src/domain/primitives").StageInstanceId,
      "core" as import("../src/domain/primitives").UnitId))?.observation.state).toBe("merged");
    expect(await pullRequests.confirm_merge({ cohort_id: cohortId, pull_request_id: firstObservation.pull_request_id,
      idempotency_key: "stale-pr", merged_at: "2026-09-29T12:00:00Z", confirmed_at: "2026-09-29T12:00:01Z" }))
      .toEqual({ ok: false, error: expect.objectContaining({ kind: "pull_request_not_current" }) });
    expect((await sql.query<{ readonly observations: string; readonly invalidated_approvals: string }>(`SELECT
      (SELECT count(*)::text FROM oakridge.pull_request_observation) AS observations,
      (SELECT count(*)::text FROM oakridge.pull_request_approval WHERE invalidated_at IS NOT NULL) AS invalidated_approvals`, []))[0])
      .toEqual({ observations: "3", invalidated_approvals: "1" });
    const confirmation = { cohort_id: cohortId, pull_request_id: secondObservation.pull_request_id, idempotency_key: "merge-core",
      merged_at: "2026-09-29T12:00:00Z", confirmed_at: "2026-09-29T12:00:01Z" };
    expect((await pullRequests.confirm_merge(confirmation)).ok).toBe(true);
    const replay = await pullRequests.confirm_merge({ ...confirmation, confirmed_at: "2026-09-29T13:00:00Z" });
    expect(replay.ok && replay.value.kind).toBe("replayed");
    const conflict = await pullRequests.confirm_merge({ ...confirmation, idempotency_key: "different" });
    expect(conflict).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict" }) });

    const webCohortId = "00000000-0000-4000-8000-000000000055" as CohortId;
    const webObservation = await pullRequests.observe({ observation: {
      provider: "github", owner: "RankOneLabs", name: "web", number: 42,
      url: "https://github.com/RankOneLabs/web/pull/42", head_branch: "cohort/web", base_branch: "release/web",
      head_sha: "head-web", state: "merged", source: "poll", observed_at: "2026-09-29T12:10:00Z", merged_at: "2026-09-29T12:10:00Z",
    }, recorded_at: "2026-09-29T12:10:01Z" });
    expect(webObservation.pull_request_id).not.toBe(secondObservation.pull_request_id);
    expect((await pullRequests.bind_verified({ cohort_id: webCohortId, ...webObservation, verified_head_sha: "head-web",
      verified_at: "2026-09-29T12:10:02Z", replace_verification_id: null })).ok).toBe(true);
    const sameKeyOtherCohort = await pullRequests.confirm_merge({ cohort_id: webCohortId,
      pull_request_id: webObservation.pull_request_id, idempotency_key: "merge-core",
      merged_at: "2026-09-29T12:10:00Z", confirmed_at: "2026-09-29T12:10:03Z" });
    expect(sameKeyOtherCohort.ok && sameKeyOtherCohort.value.kind).toBe("created");
    await sql.transaction(async (tx) => {
      await tx.query("UPDATE oakridge.cohort SET durable_version=durable_version+1 WHERE id='00000000-0000-4000-8000-000000000005'", []);
      await tx.query(`INSERT INTO oakridge.run_transition
        (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,effect_descriptor,effect_workflow_id,actor)
        VALUES ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000002','cohort',
          '00000000-0000-4000-8000-000000000005','operator',0,1,'{"kind":"start_attempt"}','effect:test','operator')`, []);
    });
    await sql.query(`INSERT INTO oakridge.attempt
      (id,run_id,stage_instance_id,cohort_id,attempt_number,status,adapter_type,request)
      VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005',1,'active','kbbl','{}')`, []);
    await sql.query(`INSERT INTO oakridge.session
      (id,run_id,stage_instance_id,attempt_id,launch_transition_id,status,kbbl_session_id,adapter_reference)
      VALUES ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000006',
        '00000000-0000-4000-8000-000000000040','pending',NULL,'{"kind":"kbbl_session"}')`, []);
    expect((await sql.query<{ readonly kbbl_session_id: string | null }>(
      "SELECT kbbl_session_id FROM oakridge.session WHERE attempt_id='00000000-0000-4000-8000-000000000006'", []))[0])
      .toEqual({ kbbl_session_id: null });

    const artifactIds = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    for (const [index, artifactId] of artifactIds.entries()) {
      await sql.query(`INSERT INTO oakridge.artifact
        (id,chain_id,revision,artifact_type,body) VALUES ($1,$1,1,'test.output',$2::jsonb)`, [artifactId, JSON.stringify({ index })]);
      await sql.query(`INSERT INTO oakridge.artifact_owner (artifact_id,run_id)
        VALUES ($1,'00000000-0000-4000-8000-000000000002')`, [artifactId]);
      await sql.query(`INSERT INTO oakridge.artifact_provenance (artifact_id,kind,run_id,import_source)
        VALUES ($1,'import','00000000-0000-4000-8000-000000000002',$2::jsonb)`, [artifactId, JSON.stringify({ source: "fixture" })]);
    }
    await expect(sql.query(`INSERT INTO oakridge.artifact
      (id,chain_id,revision,parent_artifact_id,artifact_type,body,lifecycle)
      VALUES ('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000099',2,$1,
        'test.output','{}','superseded')`, [artifactIds[0]])).rejects.toThrow("invalid parent");
    await expect(sql.query(`INSERT INTO oakridge.artifact
      (id,chain_id,revision,parent_artifact_id,artifact_type,body)
      VALUES ('00000000-0000-4000-8000-000000000014',$1,2,$1,'test.output','{}')`,
      [artifactIds[0]])).rejects.toThrow();
    expect((await sql.query<{ readonly kind: string; readonly session_id: string | null }>(
      "SELECT kind,session_id::text FROM oakridge.artifact_provenance WHERE artifact_id=$1", [artifactIds[0]]))[0])
      .toEqual({ kind: "import", session_id: null });

    const gateId = "00000000-0000-4000-8000-000000000020";
    await sql.query(`INSERT INTO oakridge.wait_gate
      (id,run_id,kind,closes_on,command_workflow_id) VALUES ($1,'00000000-0000-4000-8000-000000000002','gate','{}','gate:test')`, [gateId]);
    for (const artifactId of artifactIds) await sql.query(
      "INSERT INTO oakridge.wait_gate_artifact_revision (wait_gate_id,artifact_id,run_id) VALUES ($1,$2,'00000000-0000-4000-8000-000000000002')", [gateId, artifactId]);
    await sql.query(`INSERT INTO oakridge.wait_gate_output_slot
      (wait_gate_id,run_id,receiving_stage_instance_id,output_name,collection_key) VALUES
      ($1,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','result',NULL),
      ($1,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','report','a'),
      ($1,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','assessment',NULL)`, [gateId]);
    await sql.query(`INSERT INTO oakridge.wait_gate
      (id,run_id,kind,closes_on,command_workflow_id) VALUES
      ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002','external','{}','wait:no-artifact')`, []);
    expect((await sql.query<{ readonly revisions: string; readonly slots: string }>(`SELECT
      (SELECT count(*)::text FROM oakridge.wait_gate_artifact_revision WHERE wait_gate_id=$1) AS revisions,
      (SELECT count(*)::text FROM oakridge.wait_gate_output_slot WHERE wait_gate_id=$1) AS slots`, [gateId]))[0])
      .toEqual({ revisions: "3", slots: "3" });

    await sql.query(`INSERT INTO oakridge.session_message
      (id,run_id,sender_kind,sender_id,recipient_kind,recipient_id,thread_id,message_id,body,delivery_key)
      VALUES ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000002',
        'operator','operator','agent','worker','thread-1','message-1','{"text":"go"}','delivery-1')`, []);
    expect((await sql.query<{ readonly cohort_id: string | null; readonly artifact_thread_id: string | null }>(
      "SELECT cohort_id::text,artifact_thread_id::text FROM oakridge.session_message WHERE delivery_key='delivery-1'", []))[0])
      .toEqual({ cohort_id: null, artifact_thread_id: null });

    expect((await sql.query<{ readonly cohort_version: string; readonly stage_version: string; readonly run_version: string }>(`SELECT
      (SELECT durable_version::text FROM oakridge.cohort WHERE id='00000000-0000-4000-8000-000000000005') AS cohort_version,
      (SELECT durable_version::text FROM oakridge.stage_instance WHERE id='00000000-0000-4000-8000-000000000003') AS stage_version,
      (SELECT record_version::text FROM oakridge.workflow_run WHERE id='00000000-0000-4000-8000-000000000002') AS run_version`, []))[0])
      .toEqual({ cohort_version: "1", stage_version: "0", run_version: "0" });

    await sql.transaction(async (tx) => {
      await tx.query("UPDATE oakridge.stage_instance SET durable_version=durable_version+1 WHERE id='00000000-0000-4000-8000-000000000003'", []);
      await tx.query(`INSERT INTO oakridge.run_transition
        (id,run_id,owner_kind,owner_stage_instance_id,launch_reason,prior_owner_version,resulting_owner_version,effect_descriptor,effect_workflow_id,actor)
        VALUES ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000002','stage_instance',
          '00000000-0000-4000-8000-000000000003','recovery',0,1,'{"kind":"none"}','effect:stage-test','system')`, []);
    });
    expect((await sql.query<{ readonly cohort_version: string; readonly stage_version: string; readonly run_version: string }>(`SELECT
      (SELECT durable_version::text FROM oakridge.cohort WHERE id='00000000-0000-4000-8000-000000000005') AS cohort_version,
      (SELECT durable_version::text FROM oakridge.stage_instance WHERE id='00000000-0000-4000-8000-000000000003') AS stage_version,
      (SELECT record_version::text FROM oakridge.workflow_run WHERE id='00000000-0000-4000-8000-000000000002') AS run_version`, []))[0])
      .toEqual({ cohort_version: "1", stage_version: "1", run_version: "0" });

    await expect(sql.query(`INSERT INTO oakridge.run_transition
      (id,run_id,owner_kind,owner_stage_instance_id,launch_reason,prior_owner_version,resulting_owner_version,effect_descriptor,effect_workflow_id,actor)
      VALUES ('00000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000002','stage_instance',
        '00000000-0000-4000-8000-000000000003','recovery',41,42,'{"kind":"none"}','effect:invalid-version','system')`,
    [])).rejects.toThrow("does not match persisted version");
  } finally {
    await sql.close();
  }
}, 60_000);
