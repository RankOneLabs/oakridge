import { expect, test } from "bun:test";
import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor, type TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { matchesStoredSchema } from "../src/storage/storage-validator";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import { createMutationService } from "../src/storage/mutation-service";
import type { CoreClient } from "../src/core-client/client";
import { CORE_MAX_FRAME_BYTES, type CheckedValue, type DefinitionBundle } from "../src/core-client/generated-contracts";
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
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)", [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: "text" } }, { key: "text", shape: { kind: "string", min_length: 0, max_length: 2_000_000 } }], scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [{ key: "workers", limit: 1 }], outputs: [{ key: "report", schema: "unit", producers: [] }] }] }), JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads: [] }] })]);
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
    if (request.decision.kind !== "apply") throw new Error("fixture requires an apply decision");
    // Schema-valid (each entry within the fixture's 2,000,000-char text bound) yet larger than one evaluate frame.
    const entry_chars = 1_000_000;
    const huge: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: Array.from({ length: Math.ceil(CORE_MAX_FRAME_BYTES / entry_chars) + 1 },
      (_, index) => ({ key: `payload-${String(index).padStart(3, "0")}`, value: { schema: "text", data: { kind: "string", value: "x".repeat(entry_chars) } } })) } };
    const oversized = await commitDecision(db, { ...request, decision: { ...request.decision, mutations: [{ kind: "set_state", value: huge }], invocations: [], targets: [] } }, source);
    expect(oversized).toMatchObject({ ok: true, value: { kind: "snapshot_too_large", scope: "scope", limit: CORE_MAX_FRAME_BYTES, bytes: expect.any(Number), largest_roots: expect.any(Array) } });
    const aborted = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.ingress_receipt", []);
    expect(aborted[0]?.count).toBe("0");
    const forced = (code: string, constraint?: string): TransactionalSqlExecutor => ({ query: db.query.bind(db), transaction: async () => { throw { code, constraint }; } });
    expect(await commitDecision(forced("40P01"), request, source)).toMatchObject({ ok: true, value: { kind: "Conflict" } });
    expect(await commitDecision(forced("23505", "transition_scope_id_trigger_id_key"), request, source)).toMatchObject({ ok: true, value: { kind: "Rejected", constraint: "transition_scope_id_trigger_id_key" } });
    let queries = 0;
    const no_sql: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: async (operation) => operation({ query: async () => { queries++; throw new Error("unexpected SQL"); } }) };
    const forged_relation = { ...request, read_set: { ...request.read_set, rows: [{ relation: "unknown_relation", id: "scope", version: 0 }] } } as unknown as CommitRequest;
    expect(await commitDecision(no_sql, forged_relation, source)).toMatchObject({ ok: true, value: { kind: "Rejected", detail: "unknown read relation: unknown_relation" } });
    expect(queries).toBe(0);
    const result = await commitDecision(faulting, request, source);
    expect(result.ok).toBe(false);
    const rows = await db.query<{ state_version: string; receipt_count: string; output_count: string; reservation_count: string; effect_count: string }>("SELECT (SELECT version::text FROM authority.scope_instance WHERE id='scope') AS state_version, (SELECT count(*)::text FROM authority.ingress_receipt) AS receipt_count, (SELECT count(*)::text FROM authority.output_slot) AS output_count, (SELECT count(*)::text FROM authority.capacity_reservation) AS reservation_count, (SELECT count(*)::text FROM authority.effect_intent) AS effect_count", []);
    expect(rows[0]).toEqual({ state_version: "0", receipt_count: "0", output_count: "0", reservation_count: "0", effect_count: "0" });
    let snapshots = 0;
    let deadlocks = 0;
    const retrying: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) => {
      if (isolation === "repeatable read") { snapshots++; return db.transaction(operation, isolation); }
      if (deadlocks++ === 0) return Promise.reject({ code: "40P01" });
      return db.transaction(operation, isolation);
    } };
    const core = { request: async () => ({ ok: true, value: { kind: "evaluated", value: { kind: "wait", reason: "pause",
      continuations: [], explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" } } } }) } as unknown as CoreClient;
    const retried = await createMutationService(retrying, core).decide({ run_id: "run" as RunId, scope_id: "scope" as ScopeId,
      ingress_id: "retried", trigger, operator_version: null });
    expect({ result: retried.ok && retried.value.kind, snapshots }).toEqual({ result: "Committed", snapshots: 2 });
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
