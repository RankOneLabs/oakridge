import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { RunId, ScopeId } from "../src/storage/schema-records";

test("concurrent publications cannot overwrite a slot without a predecessor", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for PostgreSQL concurrency tests");
  const name = `publication_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }], scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: "workers", limit: 1 }], outputs: [{ key: "report", schema: "unit", producers: [], publication_trigger: "start" }] }] }), JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads: [] }] })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(value)]);
    const source = (await readSnapshot(db, "scope" as ScopeId, { id: "t", key: "start", payload: value }))!;
    const make = (id: string): CommitRequest => ({
      identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: id, request_digest: id }, read_set: source.read_set, operator_version: null,
      decision: { kind: "wait", reason: "pause", continuations: [], explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" } },
      outputs: [{ scope_id: "scope" as ScopeId, output_key: "report", collection_key: "", body: value, predecessor_id: null, expected_slot_version: null, execution_id: null }],
      capacity: [], effects: [],
    });
    const outcomes = await Promise.all([commitDecision(db, make("one"), source), commitDecision(db, make("two"), source)]);
    expect(outcomes.filter((result) => result.ok && result.value.kind === "Committed")).toHaveLength(1);
    const rows = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.artifact_revision", []);
    expect(rows[0]?.count).toBe("1");
    for (const id of ["sibling-a", "sibling-b"]) await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state) VALUES ($1,'run','scope','root',$1,$2,$2)", [id, JSON.stringify(value)]);
    const sibling = (await readSnapshot(db, "sibling-b" as ScopeId, { id: "sibling-trigger", key: "start", payload: value }))!;
    let release_lock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release_lock = resolve; });
    let signal_locked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => { signal_locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.query("SELECT id FROM authority.scope_instance WHERE id='sibling-a' FOR UPDATE", []);
      signal_locked();
      await held;
    });
    await locked;
    const other = commitDecision(db, { identity: { run_id: "run" as RunId, scope_id: "sibling-b" as ScopeId, ingress_id: "sibling", request_digest: "sibling" },
      read_set: sibling.read_set, operator_version: null, decision: { kind: "wait", reason: "pause", continuations: [],
        explanation: { bundle_digest: "digest", node_id: "n", owner: "sibling-b", read_set: [], trace: [], trigger_id: "sibling-trigger" } },
      outputs: [], capacity: [], effects: [] }, sibling);
    try {
      expect(await Promise.race([other.then((result) => result.ok && result.value.kind === "Committed"),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))])).toBe(true);
    } finally { release_lock(); await holder; await other; }
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
