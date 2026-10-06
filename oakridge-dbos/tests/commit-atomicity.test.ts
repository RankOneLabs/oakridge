import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { matchesStoredSchema } from "../src/storage/storage-validator";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";
import type { PoolId, RunId, ScopeId } from "../src/storage/schema-records";

test("a fault after state, output and reservation writes rolls the entire decision back", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for PostgreSQL commit tests");
  const name = `atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const value: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,'{}')", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }], scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: "workers", limit: 1 }], outputs: [{ key: "report", schema: "unit", producers: [] }] }] })]);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(value)]);
    await db.query("INSERT INTO authority.capacity_pool (id,run_id,pool_key,capacity) VALUES ('pool','run','workers',1)", []);
    const trigger = { id: "t", key: "start", payload: value };
    const source = (await readSnapshot(db, "scope" as ScopeId, trigger))!;
    const request: CommitRequest = {
      identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: "i", request_digest: "digest" },
      read_set: source.read_set, operator_version: null,
      decision: { kind: "apply", explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" }, mutations: [{ kind: "set_state", value }, { kind: "acquire", pool: "workers" }], invocations: [], targets: [] },
      outputs: [{ scope_id: "scope" as ScopeId, output_key: "report", collection_key: "", body: value, predecessor_id: null, expected_slot_version: null, execution_id: null }],
      capacity: [{ kind: "acquire", pool_id: "pool" as PoolId, scope_id: "scope" as ScopeId }],
      effects: [],
    };
    // The receipt is the last write of a decision; a fault there must undo every earlier one.
    const faulting: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) => db.transaction((tx) => operation({ query: async (sql, params) => {
      if (sql.startsWith("INSERT INTO authority.ingress_receipt")) throw new Error("injected fault after domain writes");
      return tx.query(sql, params);
    } }), isolation) };
    const hostile = { ...request, decision: { ...request.decision, mutations: [{ kind: "overwrite_everything" }] } } as unknown as CommitRequest;
    const rejected = await commitDecision(db, hostile, source);
    expect(rejected.ok).toBe(false);
    const invalid_state = await commitDecision(db, { ...request, decision: { ...request.decision, kind: "apply", mutations: [{ kind: "set_state", value: { schema: "wrong-schema", data: { kind: "string", value: "hostile" } } }], invocations: [], targets: [] } }, source);
    expect(invalid_state).toMatchObject({ ok: true, value: { kind: "Rejected", detail: "state schema mismatch" } });
    const forged_state = await commitDecision(db, { ...request, decision: { ...request.decision, kind: "apply", mutations: [{ kind: "set_state", value: { schema: "unit", data: { kind: "integer", value: 1 } } }], invocations: [], targets: [] } }, source);
    expect(forged_state).toMatchObject({ ok: true, value: { kind: "Rejected", detail: "state schema mismatch" } });
    const observation = await commitDecision(db, { ...request, decision: { ...request.decision, kind: "apply", mutations: [{ kind: "observe", resource: "repo" }], invocations: [], targets: [] } }, source);
    expect(observation).toMatchObject({ ok: false, error: { operation: "validate_commit", detail: "observe requires a resource observation provider; unsupported by this composition" } });
    const invalid_output = await commitDecision(db, { ...request, outputs: request.outputs.map((output) => ({ ...output, body: { schema: "unit", data: { kind: "integer", value: 1 } } })) }, source);
    expect(invalid_output).toMatchObject({ ok: true, value: { kind: "Rejected", detail: "output schema mismatch" } });
    const result = await commitDecision(faulting, request, source);
    expect(result.ok).toBe(false);
    const rows = await db.query<{ state_version: string; receipt_count: string; output_count: string; reservation_count: string; effect_count: string }>("SELECT (SELECT version::text FROM authority.scope_instance WHERE id='scope') AS state_version, (SELECT count(*)::text FROM authority.ingress_receipt) AS receipt_count, (SELECT count(*)::text FROM authority.output_slot) AS output_count, (SELECT count(*)::text FROM authority.capacity_reservation) AS reservation_count, (SELECT count(*)::text FROM authority.effect_intent) AS effect_count", []);
    expect(rows[0]).toEqual({ state_version: "0", receipt_count: "0", output_count: "0", reservation_count: "0", effect_count: "0" });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});


test("storage schema validation rejects a nested value with the wrong schema", async () => {
  const bundle: DefinitionBundle = await Bun.file(new URL("../../workflow-core/fixtures/bundles/minimal.json", import.meta.url)).json();
  const value: CheckedValue = { schema: "position", data: { kind: "variant", variant: "ready", value: { schema: "flag", data: { kind: "boolean", value: true } } } };
  expect(matchesStoredSchema(bundle, "position", value)).toBe(false);
});

test("storage schema validation rejects missing required record fields", async () => {
  const bundle: DefinitionBundle = await Bun.file(new URL("../../workflow-core/fixtures/bundles/minimal.json", import.meta.url)).json();
  expect(matchesStoredSchema(bundle, "member", { schema: "member", data: { kind: "record", fields: [], dictionary: [] } })).toBe(false);
});
