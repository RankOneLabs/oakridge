import { afterAll, expect, test } from "bun:test";
import { applyMigrations } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { applyCommand, type Evaluator, type CommandRequest } from "../src/mutation/apply-command";
import type { ScopeId } from "../src/mutation/scope-version";
import type { CheckedValue, DecisionOutcome } from "../src/core-client/generated-contracts";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); }, 30_000);
const scope_id = "00000000-0000-4000-8000-000000000101" as ScopeId;
const value: CheckedValue = { schema: "test", data: { kind: "string", value: "initial" } };
const next: CheckedValue = { schema: "test", data: { kind: "string", value: "next" } };
const decision: DecisionOutcome = { kind: "apply", mutations: [{ kind: "set_state", value: next }],
  invocations: [], targets: [], explanation: { owner: scope_id, bundle_digest: "test-digest", node_id: "node",
    trigger_id: "trigger", read_set: [{ identity: scope_id, version: 1 }], trace: [] } };
const request: CommandRequest = { scope_id, ingress_id: "command-1", digest: "digest-1", expected_version: 1,
  trigger: { id: "trigger", key: "advance", payload: value } };

export async function seededDatabase(name: string): Promise<PgPostgresExecutor> {
  const created = await createScratchDatabase(name);
  if (!created.ok) throw new Error(created.error.detail);
  scratches.push(created.value);
  const sql = PgPostgresExecutor.connect(created.value.url);
  await applyMigrations(sql);
  await sql.query("INSERT INTO oakridge_replacement.definition_bundle(digest,checked_bundle,content_pins) VALUES ('test-digest',$1,'{}')", [JSON.stringify({ operations: [] })]);
  await sql.query("INSERT INTO oakridge_replacement.run(id,bundle_digest) VALUES ($1,'test-digest')", ["00000000-0000-4000-8000-000000000102"]);
  await sql.query("INSERT INTO oakridge_replacement.scope_instance(id,run_id,template_key,input) VALUES ($1,$2,'test',$3)",
    [scope_id, "00000000-0000-4000-8000-000000000102", JSON.stringify(value)]);
  await sql.query(`INSERT INTO oakridge_replacement.transition
    (id,scope_id,version,decision,read_set,changes,local_value) VALUES ($1,$2,1,$3,'[]','[]',$4)`,
    ["00000000-0000-4000-8000-000000000103", scope_id, JSON.stringify(decision), JSON.stringify(value)]);
  return sql;
}
const evaluator = (calls: { count: number }): Evaluator => ({ async evaluate() { calls.count++; return { ok: true, value: decision }; } });

test("command commits a fact and transition, then exact replay returns the original result", async () => {
  const sql = await seededDatabase("replacement_boundary");
  try {
    const calls = { count: 0 };
    const first = await applyCommand(sql, evaluator(calls), request);
    expect(first.ok).toBe(true);
    expect(await applyCommand(sql, evaluator(calls), request)).toEqual(first);
    expect(calls.count).toBe(1);
    expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge_replacement.fact", []))[0]?.count).toBe("1");
    expect((await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge_replacement.transition", []))[0]?.count).toBe("2");
  } finally { await sql.close(); }
}, 60_000);

test("stale expected version returns typed conflict without writing a receipt", async () => {
  const sql = await seededDatabase("replacement_stale_version");
  try {
    const calls = { count: 0 };
    expect(await applyCommand(sql, evaluator(calls), { ...request, expected_version: 0 })).toEqual({ ok: false,
      error: { kind: "version_conflict", scope_id, expected: 0, actual: 1 } });
    expect(calls.count).toBe(0);
    expect(await sql.query("SELECT ingress_id FROM oakridge_replacement.ingress_receipt", [])).toEqual([]);
  } finally { await sql.close(); }
}, 60_000);

test("changed payload under the same ingress identity is rejected", async () => {
  const sql = await seededDatabase("replacement_ingress_conflict");
  try {
    await applyCommand(sql, evaluator({ count: 0 }), request);
    expect(await applyCommand(sql, evaluator({ count: 0 }), { ...request, digest: "changed" })).toEqual({ ok: false,
      error: { kind: "ingress_conflict", scope_id, ingress_id: "command-1" } });
  } finally { await sql.close(); }
}, 60_000);
