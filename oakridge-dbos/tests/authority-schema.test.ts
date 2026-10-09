import { expect, test } from "bun:test";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { deleteRun } from "../src/storage/run-lifecycle";

const BASELINE_DIGEST = "539600bbd4e57559075afb036878e2d0fab760e13c9e8a2fbae160d099c349b5";

test("baseline creates constrained authority relations and accepts a matching second application", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for the PostgreSQL authority integration test");
  const name = `authority_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const test_url = new URL(admin_url);
  test_url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(test_url.href);
  try {
    await db.query("CREATE SCHEMA dbos; CREATE TABLE dbos.system_state (id integer)", []);
    await migrateEmptyDatabase(db);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='authority' ORDER BY table_name", []);
    expect(tables.map((row) => row.table_name)).toEqual(["artifact_revision", "capacity_pool", "capacity_reservation", "child_collection", "collaboration_delivery", "collaboration_message", "collaboration_thread", "definition_bundle", "effect_intent", "execution", "execution_selection", "fact", "ingress_receipt", "launch_receipt", "operator_event", "output_slot", "project", "prompt_content", "resource_binding", "review_item", "run", "schema_baseline", "scope_export", "scope_instance", "transition"]);
    const indexes = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='authority'", []);
    for (const name of ["artifact_revision_scope_idx", "effect_intent_status_idx", "effect_intent_session_id_idx", "fact_scope_idx", "transition_scope_idx", "execution_selection_execution_idx", "transition_scope_created_idx", "transition_commit_idx", "operator_event_commit_idx", "fact_scope_key_idx"])
      expect(indexes.some((row) => row.indexname === name)).toBe(true);
    const constraints = await db.query<{ table_name: string; type: string; definition: string }>(`SELECT c.conrelid::regclass::text AS table_name,c.contype AS type,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c WHERE c.connamespace='authority'::regnamespace`, []);
    const statuses = await db.query<{ table_name: string; udt_name: string }>("SELECT table_name,udt_name FROM information_schema.columns WHERE table_schema='authority' AND column_name='status' ORDER BY table_name", []);
    expect(statuses).toEqual([{ table_name: "effect_intent", udt_name: "effect_status" }, { table_name: "execution", udt_name: "execution_status" }]);
    for (const name of ["scope_export", "child_collection", "execution_selection", "execution", "artifact_revision", "output_slot", "fact", "transition", "ingress_receipt", "effect_intent", "capacity_reservation", "resource_binding", "collaboration_thread", "collaboration_message", "review_item", "collaboration_delivery"])
      expect(constraints.some((row) => row.table_name === `authority.${name}` && row.type === "f" && row.definition.includes("FOREIGN KEY (run_id, scope_id)"))).toBe(true);
    const digest = createHash("sha256").update(await Bun.file(new URL("../src/storage/migrations/0001_core_authority.sql", import.meta.url)).text()).digest("hex");
    expect(digest).toBe(BASELINE_DIGEST);
    expect(await db.query<{ digest: string }>("SELECT digest FROM authority.schema_baseline", [])).toEqual([{ digest }]);
    const columns = await db.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      "SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='authority'", []);
    expect(columns.some((row) => row.table_name === "artifact_revision" && row.column_name === "collection_key" && row.is_nullable === "NO" && row.column_default === "''::text")).toBe(true);
    for (const name of ["fact", "ingress_receipt"]) expect(columns.some((row) => row.table_name === name && row.column_name === "version")).toBe(false);
    expect(columns.some((row) => row.table_name === "execution" && row.column_name === "publication_secret_hash")).toBe(true);
    for (const [table_name, column_name] of [["artifact_revision", "created_at"], ["execution", "created_at"], ["execution", "completed_at"], ["effect_intent", "updated_at"], ["run", "project_id"], ["project", "session_policy"], ["definition_bundle", "created_at"], ["definition_bundle", "authoring"], ["operator_event", "commit_txid"]])
      expect(columns.some((row) => row.table_name === table_name && row.column_name === column_name)).toBe(true);
    // Stored prompt text must hash to its digest; a mislabeled row is refused.
    await db.query("INSERT INTO authority.prompt_content (content_digest,content) VALUES ($1,$2)", [createHash("sha256").update("prompt").digest("hex"), "prompt"]);
    await expect(db.query("INSERT INTO authority.prompt_content (content_digest,content) VALUES ($1,$2)", [createHash("sha256").update("prompt").digest("hex").replace(/^./, "0"), "other"])).rejects.toMatchObject({ code: "23514" });
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root','{}','{}')", []);
    await db.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ('first','scope','same','{}')", []);
    await expect(db.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ('second','scope','same','{}')", [])).rejects.toMatchObject({ code: "23505" });
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('other-run','bundle')", []);
    await expect(db.query("INSERT INTO authority.fact (id,run_id,scope_id,fact_key,payload) VALUES ('cross-run','other-run','scope','event','{}')", [])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('bad-status','scope','worker',1,'unknown')", [])).rejects.toMatchObject({ code: "22P02" });
    await expect(db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload,status) VALUES ('bad-effect','scope','key','{}','unknown')", [])).rejects.toMatchObject({ code: "22P02" });
    const inserted_intent = await db.query<{ updated_at: Date }>("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload) VALUES ('effect','scope','key','{}') RETURNING updated_at", []);
    await db.query("SELECT pg_sleep(0.01)", []);
    const updated_intent = await db.query<{ updated_at: Date }>("UPDATE authority.effect_intent SET status='acknowledged' WHERE id='effect' RETURNING updated_at", []);
    expect(updated_intent[0]!.updated_at.getTime()).toBeGreaterThan(inserted_intent[0]!.updated_at.getTime());
    await db.query("SELECT pg_sleep(0.01)", []);
    const updated_payload = await db.query<{ updated_at: Date }>("UPDATE authority.effect_intent SET payload='{\"handle\":null}' WHERE id='effect' RETURNING updated_at", []);
    expect(updated_payload[0]!.updated_at.getTime()).toBeGreaterThan(updated_intent[0]!.updated_at.getTime());
    await db.query("INSERT INTO authority.artifact_revision (id,scope_id,output_key,body) VALUES ('revision','scope','document','{}')", []);
    await db.query("INSERT INTO authority.collaboration_thread (id,run_id,scope_id,artifact_revision_id,context) VALUES ('thread','run','scope','revision','{}')", []);
    await db.query("INSERT INTO authority.collaboration_message (id,run_id,scope_id,thread_id,body) VALUES ('message','run','scope','thread','{}')", []);
    await db.query("INSERT INTO authority.review_item (id,run_id,scope_id,artifact_revision_id,thread_id,body) VALUES ('review','run','scope','revision','thread','{}')", []);
    await db.query("INSERT INTO authority.collaboration_delivery (id,run_id,scope_id,message_id,payload) VALUES ('delivery','run','scope','message','{}')", []);
    await db.query("INSERT INTO authority.operator_event (id,run_id,run_key,event_key,payload) VALUES ('event','run','run','created','{}')", []);
    expect(await deleteRun(db, "run")).toEqual({ kind: "deleted" });
    const retained = await db.query<{ run_id: string | null; run_key: string }>("SELECT run_id,run_key FROM authority.operator_event WHERE id='event'", []);
    expect(retained).toEqual([{ run_id: null, run_key: "run" }]);
    for (const table of ["collaboration_delivery", "review_item", "collaboration_message", "collaboration_thread"])
      expect(await db.query(`SELECT id FROM authority.${table} WHERE run_id='run'`, [])).toEqual([]);
    await expect(migrateEmptyDatabase(db)).resolves.toBeUndefined();
    await db.query("UPDATE authority.schema_baseline SET digest=$1", ["0".repeat(64)]);
    await expect(migrateEmptyDatabase(db)).rejects.toThrow(`recorded ${"0".repeat(64)}, current ${digest}`);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("PostgreSQL 14 is rejected before applying the baseline", async () => {
  const db = { query: async () => [{ server_version_num: "140000" }] } as unknown as TransactionalSqlExecutor;
  await expect(migrateEmptyDatabase(db)).rejects.toThrow("PostgreSQL 15+");
});
