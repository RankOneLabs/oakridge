import { expect, test } from "bun:test";
import { cancelRun, deleteRun, deletionEligibility, materializeSelectedIntents } from "../src/effects/reconcile";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { Pool } from "pg";
import type { EffectPayload } from "../src/effects/leases";
import { selectedInvocation, type InvocationId } from "../src/effects/provider";
import type { Invocation } from "../src/core-client/generated-contracts";

const selection = { definition: { operation: "run", provider: "kbbl", contract_version: 1, deadline_ms: 1000, input_schema: "input",
  max_attempts: 1, outputs: [], settings: [], tools: [] }, input: { schema: "input", data: { kind: "string", value: "pinned" } },
  selection: { worker: "agent", action: "build" } } satisfies Invocation;
const payload: EffectPayload = { action: "start", handle: null, invocation: selectedInvocation("invocation-1" as InvocationId, "execution-1", selection) };

test("cancelling an uncertain start retains its identity in a stop intent", async () => {
  const inserted: Array<readonly unknown[]> = [];
  const db = {
    transaction: async <Value>(operation: (tx: TransactionalSqlExecutor) => Promise<Value>) => operation(db as TransactionalSqlExecutor),
    query: async (sql: string, parameters: readonly unknown[]) => {
      if (sql.includes("SELECT id FROM authority.run")) return [{ id: "run" }];
      if (sql.includes("payload ? 'schema'")) return [];
      if (sql.includes("FROM authority.effect_intent e") && sql.includes("FOR UPDATE OF e"))
        return [{ id: "start", scope_id: "scope", execution_id: "execution-1", effect_key: "start", payload, status: "uncertain" }];
      if (sql.includes("INSERT INTO authority.effect_intent")) inserted.push(parameters);
      return [];
    },
  } as unknown as TransactionalSqlExecutor;
  expect(await cancelRun(db, { kind: "cancel_run", run_id: "run", reason: "operator" })).toEqual({ kind: "cancelled", stop_intents: 1 });
  const stop = JSON.parse(String(inserted[0]?.[4])) as EffectPayload;
  expect(stop.invocation.id).toBe(payload.invocation.id);
  expect(stop.handle).toBeNull();
});

test("deletion is refused while an external cleanup obligation remains", async () => {
  const db = {
    transaction: async <Value>(operation: (tx: TransactionalSqlExecutor) => Promise<Value>) => operation(db as TransactionalSqlExecutor),
    query: async (sql: string) => sql.includes("count(*)") ? [{ count: "1" }] : [],
  } as unknown as TransactionalSqlExecutor;
  expect(await deletionEligibility(db, "run")).toEqual({ kind: "refused", obligations: 1 });
});

test("selected invocation survives cancellation and blocks deletion until stop is acknowledged", async () => {
  const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!adminUrl) return;
  const name = `cancel_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
    await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution-1','scope','agent',1,'pending')", []);
    await db.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ('selection','scope','agent','execution-1',1)", []);
    await db.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ('transition','scope','trigger',$1)",
      [JSON.stringify({ kind: "apply", invocations: [selection], mutations: [], targets: [], explanation: { bundle_digest: "x", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "trigger" } })]);
    await db.query("INSERT INTO authority.ingress_receipt (id,run_id,scope_id,ingress_id,request_digest,result) VALUES ('receipt','run','scope','ingress','digest',$1)",
      [JSON.stringify({ transition_id: "transition", scope_version: 1 })]);
    await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('start','scope','execution-1','ingress:0',$1)",
      [JSON.stringify(selection.input)]);
    expect(await materializeSelectedIntents(db)).toBe(1);
    const starts = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE id='start'", []);
    expect(starts[0]?.payload.invocation.selection).toEqual(selection);
    expect(await cancelRun(db, { kind: "cancel_run", run_id: "run", reason: "operator" })).toEqual({ kind: "cancelled", stop_intents: 1 });
    expect(await deleteRun(db, "run")).toEqual({ kind: "refused", obligations: 1 });
    await db.query("UPDATE authority.effect_intent SET status='cleanup_confirmed' WHERE effect_key='ingress:0:stop'", []);
    expect(await deleteRun(db, "run")).toEqual({ kind: "deleted" });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
