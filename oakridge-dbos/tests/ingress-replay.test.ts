import { expect, test } from "bun:test";
import { applyCommand, type Evaluator } from "../src/mutation/apply-command";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase } from "./support/durable-database";
import { applyMigrations } from "../src/storage/migrate";
import type { ScopeId } from "../src/mutation/scope-version";
import type { CheckedValue, DecisionOutcome } from "../src/core-client/generated-contracts";

test("a saved decision survives a crash before apply and is reused without reevaluation", async () => {
  const created = await createScratchDatabase("replacement_receipt_recovery");
  if (!created.ok) throw new Error(created.error.detail);
  const sql = PgPostgresExecutor.connect(created.value.url);
  const scope_id = "00000000-0000-4000-8000-000000000201" as ScopeId;
  const value: CheckedValue = { schema: "test", data: { kind: "string", value: "initial" } };
  const decision: DecisionOutcome = { kind: "apply", mutations: [{ kind: "set_state", value }], invocations: [], targets: [],
    explanation: { owner: scope_id, bundle_digest: "digest", node_id: "node", trigger_id: "trigger", read_set: [], trace: [] } };
  try {
    await applyMigrations(sql);
    await sql.query("INSERT INTO oakridge_replacement.definition_bundle(digest,checked_bundle,content_pins) VALUES ('digest',$1,'{}')", [JSON.stringify({ operations: [] })]);
    await sql.query("INSERT INTO oakridge_replacement.run(id,bundle_digest) VALUES ($1,'digest')", ["00000000-0000-4000-8000-000000000202"]);
    await sql.query("INSERT INTO oakridge_replacement.scope_instance(id,run_id,template_key,input) VALUES ($1,$2,'test',$3)",
      [scope_id, "00000000-0000-4000-8000-000000000202", JSON.stringify(value)]);
    await sql.query("INSERT INTO oakridge_replacement.transition(id,scope_id,version,decision,read_set,changes,local_value) VALUES ($1,$2,1,$3,'[]','[]',$4)",
      ["00000000-0000-4000-8000-000000000203", scope_id, JSON.stringify(decision), JSON.stringify(value)]);
    const request = { scope_id, ingress_id: "recovery", digest: "digest", expected_version: 1,
      trigger: { id: "trigger", key: "advance", payload: value } };
    const first: Evaluator = { async evaluate() { return { ok: true, value: decision }; } };
    const crashed = await applyCommand(sql, first, request, async () => { throw new Error("injected crash"); });
    expect(crashed.ok).toBe(false);
    const neverEvaluate: Evaluator = { async evaluate() { throw new Error("unexpected reevaluation"); } };
    const resumed = await applyCommand(sql, neverEvaluate, request);
    expect(resumed.ok).toBe(true);
    expect(await applyCommand(sql, neverEvaluate, request)).toEqual(resumed);
  } finally { await sql.close(); await created.value.drop(); }
}, 60_000);
