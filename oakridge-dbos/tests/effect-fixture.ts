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
  const root = original.scopes[0]!;
  const repository_schemas: Schema[] = [
    { key: "nullable_head", shape: { kind: "optional", item: "text" } },
    { key: "leaf_input", shape: { kind: "record", fields: [{ key: "repository_path", schema: "text", required: true }, { key: "expected_head", schema: "nullable_head", required: true }], dictionary: null } },
    { key: "leaf_result", shape: { kind: "record", fields: [{ key: "repository_path", schema: "text", required: true }, { key: "head", schema: "text", required: true }], dictionary: null } },
  ];
  const pr_schemas: Schema[] = [
    { key: "query", shape: { kind: "record", fields: ["owner", "name", "head_branch", "base_branch"].map((key) => ({ key, schema: "text", required: true })), dictionary: null } },
    { key: "leaf_input", shape: { kind: "record", fields: [{ key: "query", schema: "query", required: true }], dictionary: null } },
    { key: "pr_number", shape: { kind: "integer", min: 1, max: Number.MAX_SAFE_INTEGER } },
    { key: "optional_text", shape: { kind: "optional", item: "text" } },
    { key: "pr", shape: { kind: "record", fields: [
      ...["provider", "owner", "name", "url", "head_branch", "base_branch", "state", "source", "observed_at"].map((key) => ({ key, schema: "text", required: true })),
      { key: "number", schema: "pr_number", required: true }, { key: "head_sha", schema: "optional_text", required: true }, { key: "merged_at", schema: "optional_text", required: true },
    ], dictionary: null } },
    { key: "prs", shape: { kind: "list", item: "pr", max_items: 100 } },
    { key: "leaf_result", shape: { kind: "record", fields: [{ key: "observations", schema: "prs", required: true }], dictionary: null } },
  ];
  if (root.tree.kind !== "match") throw new Error("fixture must dispatch triggers");
  const scope: ScopeDefinition = { ...root, input_schema: "leaf_input",
    errors: [...root.errors, { key: "worktree_unrecoverable", payload_schema: "text" }, { key: "head_changed", payload_schema: "text" }],
    facts: [...root.facts, { key: "prepared", payload_schema: "leaf_result" }, { key: "worktree_unrecoverable", payload_schema: "text" }, { key: "head_changed", payload_schema: "text" }],
    workers: root.workers.map((worker) => ({ ...worker, result_schema: "leaf_result", actions: worker.actions.map((action) => ({ ...action,
      operation, input_schema: "leaf_input", provider: operation === "repository.prepare" ? "git" : "github", tools: [], outputs: [], prompt: null,
      settings: [{ key: "result_fact", value: "prepared" }], input: { kind: "reference", root: { kind: "input" }, path: [] } })) })),
    outputs: [],
    tree: { ...root.tree, cases: [...root.tree.cases, { variant: "prepared", node: { kind: "apply", id: "prepared", actions: [], mutations: [], outcome: { kind: "literal", schema: "result", value: { kind: "released", value: {} } } } },
      ...["worktree_unrecoverable", "head_changed"].map((variant) => ({ variant, node: { kind: "apply" as const, id: variant, actions: [], mutations: [], outcome: { kind: "literal" as const, schema: "result", value: { kind: "withdrawn", value: {} } } } }))] },
  };
  return { ...original, scopes: [scope], schemas: [...original.schemas, ...(operation === "repository.prepare" ? repository_schemas : pr_schemas)],
    operations: [{ key: operation, version: 1, input_schema: "leaf_input", providers: [operation === "repository.prepare" ? "git" : "github"], settings: ["result_fact"], tools: [] }], prompts: [] };
}
export async function begin(composition: ReturnType<typeof createProductionComposition>, bundle: DefinitionBundle, input: unknown): Promise<Started> {
  const created = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input }) });
  if (created.status !== 201) throw new Error(await created.text());
  const run: Started = await created.json();
  const decided = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit } }) });
  expect(await decided.json()).toMatchObject({ kind: "Committed" });
  return run;
}


export async function sessionBundle(): Promise<DefinitionBundle> {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const schemas: Schema[] = [
    { key: "metadata", shape: { kind: "record", fields: [], dictionary: "text" } },
    { key: "launch", shape: { kind: "record", fields: [
      ...["runtime", "rendered_prompt", "workdir", "session_name"].map((key) => ({ key, schema: "text", required: true })),
      { key: "session_identity", schema: "metadata", required: true }, { key: "worktree", schema: "metadata", required: true },
    ], dictionary: null } },
  ];
  return { ...original, schemas: [...original.schemas, ...schemas], prompts: [],
    scopes: original.scopes.map((scope) => ({ ...scope, input_schema: "launch", resources: [{ key: "repository", schema: "metadata" }, { key: "pull_request", schema: "metadata" }],
      workers: scope.workers.map((worker) => ({ ...worker, actions: worker.actions.map((action) => ({ ...action, operation: "session.execute", provider: "kbbl", input_schema: "launch", settings: [], tools: [], outputs: [], prompt: null })) })), outputs: [] })),
    operations: [{ key: "session.execute", version: 1, input_schema: "launch", providers: ["kbbl"], settings: [], tools: [] }],
  };
}
