import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { applyMigrations, migrationNames } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const MIGRATIONS = new URL("../src/storage/migrations", import.meta.url).pathname;
const BASELINE = "0015_v15_baseline.sql";

test("v15 is the only migration", async () => {
  expect(migrationNames(await readdir(MIGRATIONS))).toEqual([BASELINE]);
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
    expect(await applyMigrations(sql)).toEqual([BASELINE]);
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
    await sql.query(`INSERT INTO oakridge.attempt
      (id,run_id,stage_instance_id,cohort_id,attempt_number,status,adapter_type,request)
      VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005',1,'active','kbbl','{}')`, []);
    await sql.query(`INSERT INTO oakridge.session
      (id,run_id,stage_instance_id,attempt_id,status,kbbl_session_id,adapter_reference)
      VALUES ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000006','pending',NULL,'{"kind":"kbbl_session"}')`, []);
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

    await sql.transaction(async (tx) => {
      await tx.query("UPDATE oakridge.cohort SET durable_version=durable_version+1 WHERE id='00000000-0000-4000-8000-000000000005'", []);
      await tx.query(`INSERT INTO oakridge.run_transition
        (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,effect_descriptor,effect_workflow_id,actor)
        VALUES ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000002','cohort',
          '00000000-0000-4000-8000-000000000005','operator',0,1,'{"kind":"none"}','effect:test','operator')`, []);
    });
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
