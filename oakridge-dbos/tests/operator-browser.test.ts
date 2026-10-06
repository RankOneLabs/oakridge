import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { Hono } from "hono";
import { HTTP_ROUTES, matchRoute } from "../src/http/routes";
import { installDefinitionApi } from "../src/http/app";
import { createMutationService } from "../src/storage/mutation-service";
import { createProductionComposition } from "../src/runtime/compose";
import { withDatabase } from "./effect-fixture";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { CoreClient } from "../src/core-client/client";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { MutationService } from "../src/storage/mutation-service";

const root = resolve(import.meta.dir, "../..");
const clientPath = resolve(root, "kbbl/core/pwa/oakridge/client.ts");

interface ClientRoute { readonly method: "GET" | "POST"; readonly path: string }
function clientRoutes(): readonly ClientRoute[] {
  const source = ts.createSourceFile(clientPath, readFileSync(clientPath, "utf8"), ts.ScriptTarget.Latest, true);
  const routes: ClientRoute[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "get" || node.expression.text === "post")) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) routes.push({ method: node.expression.text === "get" ? "GET" : "POST", path: argument.text });
      if (argument && ts.isTemplateExpression(argument)) routes.push({ method: node.expression.text === "get" ? "GET" : "POST",
        path: argument.head.text + argument.templateSpans.map((span) => `:value${span.literal.text}`).join("") });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

test("every operator client route resolves to an authority table row", () => {
  const missing = clientRoutes().filter(({ method, path }) => !matchRoute(method, path));
  expect(missing).toEqual([]);
});

test("operator listing, pinning and digest launch have explicit authority", () => {
  const required: readonly ClientRoute[] = [
    { method: "GET", path: "/api/runs" }, { method: "GET", path: "/api/definitions" },
    { method: "POST", path: "/api/definitions" }, { method: "POST", path: "/runs" },
  ];
  expect(required.map(({ method, path }) => HTTP_ROUTES.find((row) => row.method === method && row.path === path)?.authority))
    .toEqual(["operator", "operator", "operator", "operator"]);
});

test("an empty definition catalog accepts a compiled bundle and lists its digest", async () => {
  const source = { key: "demo" } as DefinitionBundle;
  const catalog: { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle }[] = [];
  const db = { async query(sql: string, parameters: readonly unknown[]) {
    if (sql.startsWith("INSERT INTO authority.definition_bundle")) { catalog.push({ bundle_id: String(parameters[0]), digest: String(parameters[1]), source }); return []; }
    if (sql.includes("WHERE digest=$1")) return catalog.filter((item) => item.digest === parameters[0]);
    if (sql.includes("FROM authority.definition_bundle ORDER BY")) return catalog;
    return [];
  } } as unknown as TransactionalSqlExecutor;
  const mutations = { async pinDefinition() {
    const pinned = { bundle_id: "bundle-1", digest: "sha-1", source };
    catalog.push(pinned);
    return { ok: true, value: pinned };
  } } as unknown as MutationService;
  const app = new Hono();
  installDefinitionApi(app, { db, core: {} as CoreClient, mutations, wake: async () => {} });
  const pinned = await app.request("/api/definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(source) });
  const listed = await app.request("/api/definitions");
  expect({ pin_status: pinned.status, list_status: listed.status, rows: await listed.json() })
    .toMatchObject({ pin_status: 201, list_status: 200, rows: [{ digest: "sha-1", source: { key: "demo" } }] });
});

test("a digest launch resolves the pinned bundle before run creation", async () => {
  const source = { key: "demo", root: "root", scopes: [{ key: "root", input_schema: "unit", pools: [] }] } as unknown as DefinitionBundle;
  const checked = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
  const statements: string[] = [];
  const db = { async query(sql: string) {
    statements.push(sql);
    if (sql === "SELECT source FROM authority.definition_bundle WHERE digest=$1") return [{ source }];
    if (sql.startsWith("SELECT id FROM authority.definition_bundle")) return [{ id: "bundle-1" }];
    return [];
  }, async transaction(operation: (transaction: TransactionalSqlExecutor) => Promise<unknown>) { return operation(this as unknown as TransactionalSqlExecutor); } } as unknown as TransactionalSqlExecutor;
  const core = { async request(operation: string) {
    if (operation === "compile") return { ok: true, value: { kind: "compiled", value: { digest: "sha-1", scopes: [{ key: "root", initial: checked }] } } };
    return { ok: true, value: { kind: "validated", value: checked } };
  } } as unknown as CoreClient;
  const created = await createMutationService(db, core).startRunByDigest({ digest: "sha-1", input: {} });
  expect({ ok: created.ok, pinned_lookup: statements[0], inserted_run: statements.some((sql) => sql.startsWith("INSERT INTO authority.run")) })
    .toEqual({ ok: true, pinned_lookup: "SELECT source FROM authority.definition_bundle WHERE digest=$1", inserted_run: true });
});

test("an empty database lists, pins, launches and projects a run by digest", async () => {
  await withDatabase(async ({ url }) => {
    const composition = await createProductionComposition({ database_url: url,
      core_binary: resolve(root, "workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
    try {
      const app = composition.app;
      const emptyDefinitions = await app.request("/api/definitions");
      const emptyRuns = await app.request("/api/runs");
      expect({ definitions: await emptyDefinitions.json(), runs: await emptyRuns.json() }).toEqual({ definitions: [], runs: [] });
      const bundle: DefinitionBundle = await Bun.file(resolve(root, "workflow-core/fixtures/bundles/minimal.json")).json();
      const pinned = await app.request("/api/definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
      expect(pinned.status).toBe(201);
      const definition: { readonly digest: string } = await pinned.json();
      const launched = await app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ digest: definition.digest, input: {} }) });
      expect(launched.status).toBe(201);
      const run: { readonly run_id: string; readonly root_scope_id: string } = await launched.json();
      const runs = await app.request("/api/runs");
      const history = await app.request(`/api/runs/${run.run_id}/scopes/${run.root_scope_id}/history`);
      expect({ runs: await runs.json(), history: await history.json() }).toMatchObject({ runs: [{ run_id: run.run_id, definition_digest: definition.digest }],
        history: { scope_id: run.root_scope_id, transitions: [], facts: [] } });
    } finally { await composition.close(); }
  });
}, 15_000);
