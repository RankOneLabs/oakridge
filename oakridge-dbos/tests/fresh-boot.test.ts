import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Pool } from "pg";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";
import type { OutputPublication } from "../src/storage/commit";
import type { ScopeId } from "../src/storage/schema-records";
import { createProductionComposition } from "../src/runtime/compose";

test("empty database cold boots, compiles through workflow-cli and serves a run projection", async () => {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for the cold boot integration test");
  const name = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  let composition: Awaited<ReturnType<typeof createProductionComposition>> | null = null;
  try {
    await migrateEmptyDatabase(db);
    composition = await createProductionComposition({ database_url: url.href, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
    const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    const created = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
    expect(created.status).toBe(201);
    const run: { run_id: string; root_scope_id: string } = await created.json();
    const projection = await composition.app.request(`http://localhost/runs/${run.run_id}`);
    expect(projection.status).toBe(200);
    expect(await projection.json()).toMatchObject({ run_id: run.run_id, root_scope_id: run.root_scope_id, scope_key: bundle.root, version: 0 });
    const pools = await db.query<{ pool_key: string; capacity: number }>("SELECT pool_key,capacity FROM authority.capacity_pool WHERE run_id=$1", [run.run_id]);
    expect(pools).toEqual([{ pool_key: "work", capacity: 1 }]);
    const payload: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
    const output: OutputPublication = { scope_id: run.root_scope_id as ScopeId, output_key: "document", collection_key: "", body: payload, predecessor_id: null, expected_slot_version: null, execution_id: null };
    const malformed_outputs = [
      { ...output, predecessor_id: 42 },
      { ...output, execution_id: {} },
      { ...output, expected_slot_version: "1" },
      { ...output, expected_slot_version: -1 },
      { ...output, expected_slot_version: 0.5 },
      { ...output, expected_slot_version: Number.MAX_SAFE_INTEGER + 1 },
      { ...output, body: {} },
      { ...output, body: { schema: "unit", data: { kind: "record", fields: "invalid", dictionary: [] } } },
    ];
    for (const invalid_output of malformed_outputs) {
      const response = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "malformed", trigger: { id: "begin", key: "begin", payload }, outputs: [invalid_output] }) });
      expect(response.status).toBe(400);
    }
    const decision = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "begin", trigger: { id: "begin", key: "begin", payload } }) });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ kind: "Committed" });
    const history = await composition.app.request(`http://localhost/api/runs/${run.run_id}/scopes/${run.root_scope_id}/history`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ scope_id: run.root_scope_id, transitions: [{ trigger_id: "begin" }], facts: [{ fact_key: "begin" }] });
    const wrong_run_history = await composition.app.request(`http://localhost/api/runs/another-run/scopes/${run.root_scope_id}/history`);
    expect(wrong_run_history.status).toBe(404);
    const committed = await db.query<{ state: CheckedValue; executions: string; reservations: string; effects: string }>("SELECT local_state AS state, (SELECT count(*)::text FROM authority.execution) AS executions, (SELECT count(*)::text FROM authority.capacity_reservation WHERE is_active) AS reservations, (SELECT count(*)::text FROM authority.effect_intent) AS effects FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]);
    expect(committed[0]).toMatchObject({ state: { schema: "position", data: { kind: "variant", variant: "waiting" } }, executions: "1", reservations: "1", effects: "1" });
    const executions = await db.query<{ id: string }>("SELECT id FROM authority.execution WHERE scope_id=$1", [run.root_scope_id]);
    const published = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "output", trigger: { id: "output", key: "tick", payload }, outputs: [{ ...output, execution_id: executions[0]!.id }] }) });
    expect(await published.json()).toMatchObject({ kind: "Committed" });
    const history_after_publication = await composition.app.request(`http://localhost/api/runs/${run.run_id}/scopes/${run.root_scope_id}/history`);
    const recorded: { transitions: { trigger_id: string }[]; facts: { fact_key: string }[] } = await history_after_publication.json();
    expect(recorded.transitions.map((item) => item.trigger_id)).toEqual(["output", "begin"]);
    expect(recorded.facts.map((item) => item.fact_key).sort()).toEqual(["begin", "tick"]);
    await db.query("UPDATE authority.execution SET publication_secret_hash=$1 WHERE id=$2", ["a".repeat(64), executions[0]!.id]);
    const diagnostics = await composition.app.request(`http://localhost/api/runs/${run.run_id}/scopes/${run.root_scope_id}/diagnostics`);
    expect(JSON.stringify(await diagnostics.json())).not.toContain("publication_secret_hash");
    const scope_view = await composition.app.request(`http://localhost/api/runs/${run.run_id}/scopes/${run.root_scope_id}`);
    expect(JSON.stringify(await scope_view.json())).not.toContain("publication_secret_hash");
    expect(JSON.stringify(recorded)).not.toContain("publication_secret_hash");
    const snapshot = await readSnapshot(db, run.root_scope_id as ScopeId, { id: "snapshot", key: "tick", payload });
    expect(snapshot?.snapshot.observations).toMatchObject([{ root: { kind: "output", key: "document" }, value: payload, version: 0 }]);
  } finally {
    if (composition) await composition.close();
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}, 15_000);
