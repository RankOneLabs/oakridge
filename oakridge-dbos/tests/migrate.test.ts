import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { applyMigrations, migrationNames } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { PostgresDevFlowCohortDetailContributor, PostgresDevFlowPullRequestRepository } from "../src/storage/postgres-dev-flow";
import type { CohortId } from "../src/domain/primitives";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const MIGRATIONS = new URL("../src/storage/migrations", import.meta.url).pathname;
const BASELINE = "0015_v15_baseline.sql";
const MIGRATION_SET = [BASELINE, "0016_v15_worker_ownership.sql", "0017_v15_operation_execution.sql"];

test("v15 worker ownership follows the immutable baseline", async () => {
  expect(migrationNames(await readdir(MIGRATIONS))).toEqual(MIGRATION_SET);
});

test("an applied 0015 ledger without its schema fails with named divergence", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_ledger_divergence");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("v15 ledger PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await sql.query(`CREATE TABLE public.oakridge_schema_migration
      (name text PRIMARY KEY, applied_at timestamptz NOT NULL)`, []);
    await sql.query(`INSERT INTO public.oakridge_schema_migration (name,applied_at)
      VALUES ('0015_v15_baseline.sql',now())`, []);
    await expect(applyMigrations(sql)).rejects.toThrow("artifact_thread, attempt.idempotency_key, build_cohort");
  } finally { await sql.close(); }
});

test("a retired migration ledger is rejected even when its tables exist", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_retired_ledger");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("v15 retired-ledger PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    await sql.query("INSERT INTO public.oakridge_schema_migration (name,applied_at) VALUES ('0016_dev_flow_pull_requests.sql',now()),('0017_artifact_threads_and_attempt_idempotency.sql',now())", []);
    await expect(applyMigrations(sql)).rejects.toThrow("0016_dev_flow_pull_requests.sql, 0017_artifact_threads_and_attempt_idempotency.sql");
  } finally { await sql.close(); }
});

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); }, 30_000);

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
      (id,run_id,stage_instance_id,cohort_key,status,frozen_inputs)
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
      (id,run_id,stage_instance_id,cohort_key,status,frozen_inputs)
      VALUES ('00000000-0000-4000-8000-000000000055','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','web','active','{"brief_notes":"fixture","repositories":[]}')`, []);
    await pullRequests.create_cohort({ cohort_id: "00000000-0000-4000-8000-000000000055" as CohortId,
      stage_instance_id: "00000000-0000-4000-8000-000000000003" as import("../src/domain/primitives").StageInstanceId,
      cohort_key: "web", repository_key: "web", repository_path: "/repo/web", canonical_ref: "cohort/web",
      expected_pr_base: "release/web", recorded_head_sha: "head-web", current_verified_pull_request_id: null,
      created_at: "2026-09-29T09:00:00Z", updated_at: "2026-09-29T09:00:00Z" });
    expect(await sql.query<{ readonly repository_key: string; readonly expected_pr_base: string }>(
      "SELECT repository_key,expected_pr_base FROM dev_flow.build_cohort ORDER BY cohort_key", []))
      .toEqual([{ repository_key: "oakridge", expected_pr_base: "epic/oakridge" }, { repository_key: "web", expected_pr_base: "release/web" }]);

    const observed = (head_sha: string) => ({ provider: "github" as const, owner: "RankOneLabs", name: "oakridge", number: 42,
      url: "https://github.com/RankOneLabs/oakridge/pull/42", head_branch: "cohort/core", base_branch: "epic/oakridge",
      head_sha, state: "open" as const, source: "poll" as const, observed_at: "2026-09-29T10:00:00Z", merged_at: null });
    const firstObservation = await pullRequests.observe({ observation: observed("head-one"), recorded_at: "2026-09-29T10:00:01Z" });
    const firstBinding = await pullRequests.bind_verified({ cohort_id: cohortId, ...firstObservation, verified_head_sha: "head-one",
      verified_at: "2026-09-29T10:00:02Z", replace_verification_id: null });
    expect(firstBinding.ok).toBe(true);
    if (!firstBinding.ok) throw new Error(firstBinding.error.detail);
    const details = new PostgresDevFlowCohortDetailContributor(sql);
    expect((await details.read([cohortId])).get(cohortId)?.links).toEqual([{
      key: "pull_request", label: "Open pull request", url: observed("head-one").url,
    }]);
    expect(await details.cursor()).not.toBe("0");
    const advancedObservation = await pullRequests.observe({ observation: observed("head-two"), recorded_at: "2026-09-29T10:30:01Z" });
    const advancedBinding = await pullRequests.bind_verified({ cohort_id: cohortId, ...advancedObservation,
      verified_head_sha: "head-two", verified_at: "2026-09-29T10:30:02Z", replace_verification_id: null });
    expect(advancedBinding.ok && advancedBinding.value.binding).toBe("head_advanced");
    expect((await sql.query<{ readonly invalidation_reason: string | null }>(
      "SELECT invalidation_reason FROM dev_flow.pull_request_verification WHERE id=$1", [firstBinding.value.id]))[0]
    ).toEqual({ invalidation_reason: "head_changed" });
    const replacementObservation = { ...observed("head-three"), number: 43, url: "https://github.com/RankOneLabs/oakridge/pull/43" };
    const secondObservation = await pullRequests.observe({ observation: replacementObservation, recorded_at: "2026-09-29T11:00:01Z" });
    expect((await pullRequests.bind_verified({ cohort_id: cohortId, ...secondObservation, verified_head_sha: "head-three",
      verified_at: "2026-09-29T11:00:02Z", replace_verification_id: null })).ok).toBe(false);
    const replacement = await pullRequests.bind_verified({ cohort_id: cohortId, ...secondObservation, verified_head_sha: "head-three",
      verified_at: "2026-09-29T11:00:02Z", replace_verification_id: advancedBinding.ok ? advancedBinding.value.id : null });
    expect(replacement.ok).toBe(true);
    await pullRequests.observe({ observation: { ...replacementObservation, state: "merged",
      observed_at: "2026-09-29T12:00:00Z", merged_at: "2026-09-29T12:00:00Z" }, recorded_at: "2026-09-29T12:00:01Z" });
    expect((await pullRequests.find_current_for_unit(
      "00000000-0000-4000-8000-000000000003" as import("../src/domain/primitives").StageInstanceId,
      "core" as import("../src/domain/primitives").UnitId))?.observation.state).toBe("merged");
    expect(await pullRequests.confirm_merge({ cohort_id: cohortId, pull_request_id: firstObservation.pull_request_id,
      idempotency_key: "stale-pr", merged_at: "2026-09-29T12:00:00Z", confirmed_at: "2026-09-29T12:00:01Z" }))
      .toEqual({ ok: false, error: expect.objectContaining({ kind: "pull_request_not_current" }) });
    expect((await sql.query<{ readonly observations: string }>(`SELECT
      (SELECT count(*)::text FROM dev_flow.pull_request_observation) AS observations`, []))[0])
      .toEqual({ observations: "4" });
    const confirmation = { cohort_id: cohortId, pull_request_id: secondObservation.pull_request_id, idempotency_key: "merge-core",
      merged_at: "2026-09-29T12:00:00Z", confirmed_at: "2026-09-29T12:00:01Z" };
    expect((await pullRequests.confirm_merge(confirmation)).ok).toBe(true);
    expect((await details.read([cohortId])).get(cohortId)?.facts).toContainEqual(
      expect.objectContaining({ key: "merged_at", label: "Merged at" }));
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
        (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,event,effect_descriptor,effect_workflow_id,actor)
        VALUES ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000002','cohort',
          '00000000-0000-4000-8000-000000000005','operator',0,1,'{"kind":"derive"}','{"kind":"start_attempt"}','effect:test','operator')`, []);
    });
    await sql.query(`INSERT INTO oakridge.attempt
      (id,run_id,stage_instance_id,cohort_id,attempt_number,status,adapter_type,request,worker)
      VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005',1,'active','kbbl','{}','build')`, []);
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
      (id,run_id,stage_instance_id,cohort_id,kind,closes_on,command_workflow_id)
      VALUES ($1,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000005','gate','{}','gate:test')`, [gateId]);
    for (const artifactId of artifactIds) await sql.query(
      "INSERT INTO oakridge.wait_gate_artifact_revision (wait_gate_id,artifact_id,run_id) VALUES ($1,$2,'00000000-0000-4000-8000-000000000002')", [gateId, artifactId]);
    await sql.query(`INSERT INTO oakridge.wait_gate
      (id,run_id,stage_instance_id,cohort_id,kind,closes_on,command_workflow_id) VALUES
      ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005',
        'external','{}','wait:no-artifact')`, []);
    expect((await sql.query<{ readonly revisions: string }>(
      "SELECT count(*)::text AS revisions FROM oakridge.wait_gate_artifact_revision WHERE wait_gate_id=$1", [gateId]))[0])
      .toEqual({ revisions: "3" });

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
        (id,run_id,owner_kind,owner_stage_instance_id,launch_reason,prior_owner_version,resulting_owner_version,event,effect_descriptor,effect_workflow_id,actor)
        VALUES ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000002','stage_instance',
          '00000000-0000-4000-8000-000000000003','recovery',0,1,'{"kind":"derive"}','{"kind":"none"}','effect:stage-test','system')`, []);
    });
    expect((await sql.query<{ readonly cohort_version: string; readonly stage_version: string; readonly run_version: string }>(`SELECT
      (SELECT durable_version::text FROM oakridge.cohort WHERE id='00000000-0000-4000-8000-000000000005') AS cohort_version,
      (SELECT durable_version::text FROM oakridge.stage_instance WHERE id='00000000-0000-4000-8000-000000000003') AS stage_version,
      (SELECT record_version::text FROM oakridge.workflow_run WHERE id='00000000-0000-4000-8000-000000000002') AS run_version`, []))[0])
      .toEqual({ cohort_version: "1", stage_version: "1", run_version: "0" });

    await expect(sql.query(`INSERT INTO oakridge.run_transition
      (id,run_id,owner_kind,owner_stage_instance_id,launch_reason,prior_owner_version,resulting_owner_version,event,effect_descriptor,effect_workflow_id,actor)
      VALUES ('00000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000002','stage_instance',
        '00000000-0000-4000-8000-000000000003','recovery',41,42,'{"kind":"derive"}','{"kind":"none"}','effect:invalid-version','system')`,
    [])).rejects.toThrow("does not match persisted version");
  } finally {
    await sql.close();
  }
}, 60_000);


test("an applied worker-ownership schema is rejected when its required columns diverge", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_pre_c2");
  if (!scratch.ok) {
    if (scratch.error.operation !== "reach_admin_endpoint") throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
    console.warn("v15 pre-C2 PostgreSQL check SKIPPED: no PostgreSQL reachable");
    return;
  }
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    expect(await applyMigrations(sql)).toEqual([]);
    await sql.query("ALTER TABLE oakridge.cohort DROP COLUMN frozen_inputs", []);
    await expect(applyMigrations(sql)).rejects.toThrow("cohort.frozen_inputs");
    // These are retained ledger requirements, unlike round and cohort_output.
    await sql.query("ALTER TABLE oakridge.cohort DROP COLUMN state, DROP COLUMN depends_on", []);
    await sql.query("ALTER TABLE oakridge.run_transition DROP COLUMN event, DROP COLUMN from_state, DROP COLUMN to_state, DROP COLUMN effects_started_at", []);
    await sql.query("ALTER TABLE oakridge.attempt ALTER COLUMN request SET NOT NULL", []);
    await expect(applyMigrations(sql)).rejects.toThrow("cohort.state, cohort.depends_on");
    await expect(applyMigrations(sql)).rejects.toThrow("run_transition.event, run_transition.from_state, run_transition.to_state, run_transition.effects_started_at");
    await expect(applyMigrations(sql)).rejects.toThrow("attempt.request (nullable)");
  } finally { await sql.close(); }
});
