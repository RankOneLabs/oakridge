import { expect, test } from "bun:test";
import type { Invocation } from "../src/core-client/generated-contracts";
import { dispatchClaim, dispatchSweep } from "../src/effects/dispatch";
import type { ClaimedIntent } from "../src/effects/leases";
import { deliberateRetry, repeatInvocation, selectedInvocation, type EffectProvider, type InvocationId } from "../src/effects/provider";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { claimIntents, finishClaim } from "../src/effects/leases";
import { Pool } from "pg";

const selection = { definition: { operation: "execute", provider: "kbbl", contract_version: 1, deadline_ms: 1000,
  input_schema: "input", max_attempts: 2, outputs: [], settings: [], tools: [] },
  input: { schema: "input", data: { kind: "string", value: "pinned" } }, selection: { worker: "agent", action: "run" } } satisfies Invocation;
const invocation = selectedInvocation("invocation-1" as InvocationId, "execution-1", selection);

test("uncertain replay keeps the exact request while a deliberate retry changes identity", () => {
  const replayed = repeatInvocation(invocation);
  expect(replayed.bytes).toBe(invocation.bytes);
  const retried = deliberateRetry(invocation, "invocation-2" as InvocationId);
  expect(retried.id).not.toBe(invocation.id);
  expect(retried.bytes).not.toBe(invocation.bytes);
});
const claim = (id: string, action: "start" | "stop" = "start"): ClaimedIntent => ({
  id, scope_id: id, execution_id: "execution-1", effect_key: id, status: "in_flight", version: 2, fence: 2, owner: "dispatcher",
  payload: { invocation, action, handle: null, lease: { owner: "dispatcher", expires_at: new Date(Date.now() + 1000).toISOString(), fence: 2 } },
});

function database(rows: readonly ClaimedIntent[] = []) {
  const writes: Array<{ status: string; payload: unknown }> = [];
  const db = {
    transaction: async <Value>(operation: (tx: TransactionalSqlExecutor) => Promise<Value>) => operation(db as TransactionalSqlExecutor),
    query: async (sql: string, parameters: readonly unknown[]) => {
      if (sql.includes("payload ? 'schema'")) return [];
      if (sql.includes("RETURNING id")) { writes.push({ status: String(parameters[0]), payload: JSON.parse(String(parameters[1])) }); return [{ id: parameters[2] }]; }
      if (sql.includes("clock_timestamp")) return [{ now: new Date() }];
      if (sql.includes("FOR UPDATE OF e SKIP LOCKED")) return rows.map(({ fence: _fence, owner: _owner, ...row }) => row);
      if (sql.includes("SET status='in_flight'")) return [];
      return [];
    },
  } as unknown as TransactionalSqlExecutor;
  return { db, writes };
}

test("uncertain start retains its selected bytes and identity", async () => {
  const { db, writes } = database();
  const provider = { start: async () => ({ kind: "uncertain", detail: "response lost" }) } as unknown as EffectProvider;
  const outcome = await dispatchClaim(db, provider, claim("start"), 50);
  expect(outcome.status).toBe("uncertain");
  expect((writes[0]?.payload as ClaimedIntent["payload"]).invocation.bytes).toBe(invocation.bytes);
});

test("an unavailable stop remains an unresolved cleanup obligation", async () => {
  const { db } = database();
  const provider = { stop: async () => ({ kind: "transiently_unavailable", detail: "503" }) } as unknown as EffectProvider;
  expect((await dispatchClaim(db, provider, claim("stop", "stop"), 50)).status).toBe("cleanup_pending");
});

test("only an acknowledged stop confirms cleanup", async () => {
  const { db } = database();
  const provider = { stop: async () => ({ kind: "acknowledged", value: { stopped: true } }) } as unknown as EffectProvider;
  expect((await dispatchClaim(db, provider, claim("stop", "stop"), 50)).status).toBe("cleanup_confirmed");
});

test("a malformed stop acknowledgement does not prove termination", async () => {
  const { db } = database();
  const provider = { stop: async () => ({ kind: "acknowledged", value: {} }) } as unknown as EffectProvider;
  expect((await dispatchClaim(db, provider, claim("stop", "stop"), 50)).status).toBe("cleanup_pending");
});

test("a hung provider uses its bounded slot while another owner progresses", async () => {
  const { db } = database([claim("slow"), claim("fast")]);
  const provider = { start: async (request: typeof invocation) => request.id === "invocation-1" && request.execution_id === "execution-1"
    ? new Promise(() => {}) : { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "s" } } } as unknown as EffectProvider;
  // Use one pending response and one immediate response under the same sweep.
  let calls = 0;
  provider.start = async () => ++calls === 1 ? new Promise(() => {}) : { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "s" } };
  const outcomes = await dispatchSweep(db, provider, { owner: "dispatcher", concurrency: 2, lease_ms: 100, provider_timeout_ms: 10 });
  expect(outcomes.map((item) => item.status).sort()).toEqual(["acknowledged", "uncertain"]);
});

test("a killed dispatcher loses its lease and a new process reclaims the same invocation", async () => {
  const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!adminUrl) return;
  const name = `lease_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  const marker = `/tmp/oakridge-lease-${name}`;
  try {
    await migrateEmptyDatabase(db);
    await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
    await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
    await db.query("INSERT INTO authority.effect_intent (id,scope_id,effect_key,payload) VALUES ($1,'scope','start',$2)",
      ["intent", JSON.stringify({ invocation, action: "start", handle: null })]);
    const childCode = `import { PgPostgresExecutor } from ${JSON.stringify(new URL("../src/storage/sql-executor.ts", import.meta.url).href)};
      import { claimIntents } from ${JSON.stringify(new URL("../src/effects/leases.ts", import.meta.url).href)};
      const db=PgPostgresExecutor.connect(process.env.OAKRIDGE_LEASE_TEST_URL);
      await claimIntents(db,"dead-worker",1,150);
      await Bun.write(process.env.OAKRIDGE_LEASE_MARKER,"claimed");
      setInterval(()=>{},1000);`;
    const child = Bun.spawn(["bun", "-e", childCode], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OAKRIDGE_LEASE_TEST_URL: url.href, OAKRIDGE_LEASE_MARKER: marker } });
    for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill();
    await child.exited;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const reclaimed = await claimIntents(db, "recovery-worker", 1, 1000);
    expect(reclaimed[0]?.payload.invocation.bytes).toBe(invocation.bytes);
    expect(reclaimed[0]?.fence).toBe(2);
    const stale = { ...reclaimed[0]!, owner: "dead-worker", fence: 1 };
    expect(await finishClaim(db, stale, "acknowledged", stale.payload)).toBe(false);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await Bun.file(marker).delete().catch(() => {});
  }
});
