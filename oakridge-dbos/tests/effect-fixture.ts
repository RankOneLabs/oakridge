import { expect } from "bun:test";
import { Pool } from "pg";
import { resolve } from "node:path";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createProductionComposition } from "../src/runtime/compose";
import type { DefinitionBundle, ScopeDefinition, CheckedValue, Schema } from "../src/core-client/generated-contracts";
import type { RunId, ScopeId } from "../src/storage/schema-records";

export const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
interface TestDatabase { readonly url: string; readonly db: PgPostgresExecutor }
export async function withDatabase(operation: (database: TestDatabase) => Promise<void>): Promise<void> {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for production effect integration tests");
  const name = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  try { await migrateEmptyDatabase(db); await operation({ url: url.href, db }); }
  finally { await db.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
}
interface Started { readonly run_id: RunId; readonly root_scope_id: ScopeId }
export async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out awaiting durable effect evidence");
}
export async function operationBundle(operation: "repository.prepare" | "pull_request.observe"): Promise<DefinitionBundle> {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const shipped: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
  const root = original.scopes[0]!;
  const source_scope = shipped.scopes.find((scope) => scope.key === (operation === "repository.prepare" ? "repository_preparation" : "implementation"));
  const source_worker = source_scope?.workers.find((worker) => worker.key === (operation === "repository.prepare" ? "preparation" : "pr_observer"));
  const source_action = source_worker?.actions.find((action) => action.operation === operation);
  const manifest = shipped.operations.find((item) => item.key === operation);
  if (!source_scope || !source_worker || !source_action || !manifest) throw new Error(`shipped ${operation} declaration missing`);
  const result_fact = source_action.settings.find((setting) => setting.key === "result_fact")?.value;
  if (!result_fact) throw new Error(`shipped ${operation} result fact missing`);
  const input_schemas: Schema[] = operation === "repository.prepare" ? [
    { key: "leaf_input", shape: { kind: "record", fields: [{ key: "repository_path", schema: "repo_path", required: true }, { key: "expected_head", schema: "optional_text", required: true }], dictionary: null } },
  ] : [
    { key: "leaf_input", shape: { kind: "record", fields: [{ key: "query", schema: "pr_query", required: true }], dictionary: null } },
  ];
  if (root.tree.kind !== "match") throw new Error("fixture must dispatch triggers");
  const scope: ScopeDefinition = { ...root, input_schema: "leaf_input",
    errors: source_scope.errors,
    facts: source_scope.facts,
    workers: [{ ...source_worker, key: "author", actions: [{ ...source_action, key: "write", input_schema: "leaf_input", tools: [], outputs: [], prompt: null,
      input: { kind: "reference", root: { kind: "input" }, path: [] } }] }],
    outputs: [],
    tree: { ...root.tree, cases: [...root.tree.cases, ...source_scope.facts.map((fact) => ({ variant: fact.key, node: { kind: "apply" as const, id: fact.key, actions: [], mutations: [], outcome: { kind: "literal" as const, schema: "result", value: { kind: fact.key === result_fact ? "released" : "withdrawn", value: {} } } } }))] },
  };
  const keys = new Set(original.schemas.map((schema) => schema.key));
  return { ...original, scopes: [scope], schemas: [...original.schemas, ...shipped.schemas.filter((schema) => !keys.has(schema.key)), ...input_schemas],
    operations: [{ ...manifest, input_schema: "leaf_input" }], prompts: [] };
}
export async function begin(composition: Awaited<ReturnType<typeof createProductionComposition>>, bundle: DefinitionBundle, input: unknown): Promise<Started> {
  const created = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input }) });
  if (created.status !== 201) throw new Error(await created.text());
  const run: Started = await created.json();
  const decided = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit } }) });
  if (decided.status !== 200) throw new Error(`fixture begin returned ${decided.status}: ${await decided.text()}`);
  expect(await decided.json()).toMatchObject({ kind: "Committed" });
  return run;
}


export async function sessionBundle(): Promise<DefinitionBundle> {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const shipped: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
  const source_scope = shipped.scopes.find((scope) => scope.key === "spec_analysis");
  const source_worker = source_scope?.workers.find((worker) => worker.key === "author");
  const source_action = source_worker?.actions.find((action) => action.key === "initial");
  const manifest = shipped.operations.find((item) => item.key === "session.run");
  if (!source_scope || !source_worker || !source_action || !manifest) throw new Error("shipped session declaration missing");
  const root = original.scopes[0]!;
  if (root.tree.kind !== "match") throw new Error("fixture must dispatch triggers");
  const schemas: Schema[] = [
    { key: "metadata", shape: { kind: "record", fields: [], dictionary: "text" } },
    { key: "launch", shape: { kind: "record", fields: [
      ...["runtime", "rendered_prompt", "workdir", "session_name"].map((key) => ({ key, schema: "text", required: true })),
      { key: "session_identity", schema: "metadata", required: true }, { key: "worktree", schema: "metadata", required: true },
    ], dictionary: null } },
  ];
  return { ...original, schemas: [...original.schemas, ...schemas], prompts: [],
    scopes: [{ ...root, input_schema: "launch", resources: [{ key: "repository", schema: "metadata" }, { key: "pull_request", schema: "metadata" }],
      errors: source_scope.errors, facts: source_scope.facts,
      workers: [{ ...source_worker, actions: [{ ...source_action, key: "write", input_schema: "launch", input: { kind: "reference", root: { kind: "input" }, path: [] }, tools: [], outputs: [], prompt: null }] }],
      tree: { ...root.tree, cases: [...root.tree.cases, ...source_scope.facts.map((fact) => ({ variant: fact.key, node: { kind: "apply" as const,
        id: fact.key, actions: [], mutations: [], outcome: { kind: "literal" as const, schema: "result", value: { kind: fact.key === "submitted" ? "released" : "withdrawn", value: {} } } } }))] }, outputs: [] }],
    operations: [{ ...manifest, input_schema: "launch" }],
  };
}
