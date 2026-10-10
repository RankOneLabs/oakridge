import { expect, test } from "bun:test";
import { Hono } from "hono";
import { installDefinitionApi } from "../src/http/app";
import { createMutationService } from "../src/storage/mutation-service";
import { buildDevelopmentRun } from "../../workflow-config/src/development";
import { DEVELOPMENT_POLICY } from "../../workflow-config/src/development/policies";
import type { CoreClient } from "../src/core-client/client";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const authoring = { authoring_version: 1, template: "development", key: "development",
  implementation_capacity: 4, sibling_failure: "cancel", wire_field_order: "canonical", stage_layout: "standard" };

test("compile accepts authoring and returns a program without pinning", async () => {
  let pinned = false;
  let digest_resolved = false;
  const mutations = { async compile(request: { bundle: { prompts: readonly { content_digest: string }[];
    scopes: readonly { key: string; workers: readonly { actions: readonly { prompt?: string | null }[] }[] }[] }; authoring: unknown }) {
    digest_resolved = request.authoring !== undefined && request.bundle.prompts.every((prompt) => prompt.content_digest.length === 64)
      && request.bundle.scopes.find((scope) => scope.key === "spec_analysis")?.workers[0]?.actions[0]?.prompt === "planning_author_initial_v3";
    return { ok: true, value: { program: { digest: "compiled" } } };
  }, async pinDefinition() { pinned = true; throw new Error("unexpected pin"); } } as unknown as MutationService;
  const app = new Hono();
  installDefinitionApi(app, { db: { query: async () => [] } as unknown as TransactionalSqlExecutor,
    core: {} as CoreClient, mutations, wake: async () => {} });
  const response = await app.request("/api/definitions/compile", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...authoring, prompt_bindings: [{ stage_key: "analysis", worker_key: "author",
      action_key: "initial", prompt_key: "planning_author_initial_v3" }] }) });
  expect({ status: response.status, body: await response.json(), digest_resolved, pinned })
    .toEqual({ status: 200, body: { program: { digest: "compiled" } }, digest_resolved: true, pinned: false });
});

test("compile reports invalid authoring at its field path", async () => {
  const app = new Hono();
  installDefinitionApi(app, { db: {} as TransactionalSqlExecutor, core: {} as CoreClient,
    mutations: {} as MutationService, wake: async () => {} });
  const response = await app.request("/api/definitions/compile", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...authoring, implementation_capacity: 0 }) });
  expect({ status: response.status, body: await response.json() })
    .toEqual({ status: 422, body: { error: "capacity must be an integer between 1 and 4294967295", field_path: "implementation_capacity" } });
});

test("compile reports the supported range for an above-limit capacity", async () => {
  const app = new Hono();
  installDefinitionApi(app, { db: {} as TransactionalSqlExecutor, core: {} as CoreClient,
    mutations: {} as MutationService, wake: async () => {} });
  const response = await app.request("/api/definitions/compile", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...authoring, implementation_capacity: 4_294_967_296 }) });
  expect({ status: response.status, body: await response.json() })
    .toEqual({ status: 422, body: { error: "capacity must be an integer between 1 and 4294967295", field_path: "implementation_capacity" } });
});

test("compile reports an unknown prompt key at its binding", async () => {
  const app = new Hono();
  installDefinitionApi(app, { db: {} as TransactionalSqlExecutor, core: {} as CoreClient,
    mutations: {} as MutationService, wake: async () => {} });
  const response = await app.request("/api/definitions/compile", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...authoring, prompt_bindings: [{ stage_key: "analysis", worker_key: "author",
      action_key: "initial", prompt_key: "missing_prompt" }] }) });
  expect({ status: response.status, body: await response.json() })
    .toEqual({ status: 422, body: { error: "prompt key is not in the catalog", field_path: "prompt_bindings[0].prompt_key" } });
});

test("compile preserves the Rust compiler's declaration path", async () => {
  const mutations = { async compile() { return { ok: false,
    error: { operation: "compile", entity_id: "development", detail: JSON.stringify({ kind: "domain",
      detail: { path: "scopes[1].workers[0]", detail: "invalid action input" } }) } }; } } as unknown as MutationService;
  const app = new Hono();
  installDefinitionApi(app, { db: {} as TransactionalSqlExecutor, core: {} as CoreClient,
    mutations, wake: async () => {} });
  const response = await app.request("/api/definitions/compile", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(authoring) });
  expect({ status: response.status, body: await response.json() })
    .toEqual({ status: 422, body: { error: "invalid action input", field_path: "scopes[1].workers[0]" } });
});

test("definition detail returns saved authoring and a dependency graph", async () => {
  const bundle = buildDevelopmentRun(DEVELOPMENT_POLICY);
  const db = { query: async () => [{ bundle_id: "bundle-1", digest: "digest", source: bundle, archived_at: null, authoring }] } as unknown as TransactionalSqlExecutor;
  const app = new Hono();
  installDefinitionApi(app, { db, core: {} as CoreClient, mutations: {} as MutationService, wake: async () => {} });
  const response = await app.request("/api/definitions/bundle-1");
  const detail = await response.json() as { authoring: unknown; graph: { nodes: readonly { key: string }[]; edges: readonly { from: string; to: string }[] } };
  expect({ status: response.status, authoring: detail.authoring, prepare: detail.graph.nodes[0]?.key,
    first_dependency: detail.graph.edges[0] })
    .toEqual({ status: 200, authoring, prepare: "prepare", first_dependency: { from: "prepare", to: "analysis" } });
});

test("prompt catalog endpoint returns generated prompt keys with server digests", async () => {
  const app = new Hono();
  installDefinitionApi(app, { db: {} as TransactionalSqlExecutor, core: {} as CoreClient,
    mutations: {} as MutationService, wake: async () => {} });
  const response = await app.request("/api/prompts");
  const prompts = await response.json() as readonly { key: string; path: string; content_digest: string }[];
  expect({ status: response.status, generated: prompts.filter((prompt) => prompt.key.endsWith("_v3")).length,
    has_digest: prompts.every((prompt) => /^[0-9a-f]{64}$/.test(prompt.content_digest)) })
    .toEqual({ status: 200, generated: 21, has_digest: true });
});

test("pinning persists the authored value alongside the compiled bundle", async () => {
  const bundle = buildDevelopmentRun(DEVELOPMENT_POLICY);
  let stored_authoring: unknown = null;
  const query = async (statement: string, parameters: readonly unknown[]) => {
    if (statement.startsWith("INSERT INTO authority.definition_bundle")) { stored_authoring = JSON.parse(String(parameters[4])); return []; }
    if (statement.includes("FROM authority.definition_bundle"))
      return [{ bundle_id: "bundle-1", digest: "compiled", source: bundle, authoring: stored_authoring, archived_at: null }];
    return [];
  };
  const db = { query, transaction: async (operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }) } as unknown as TransactionalSqlExecutor;
  const core = { request: async () => ({ ok: true, value: { kind: "compiled", value: { digest: "compiled", scopes: [] } } }) } as unknown as CoreClient;
  const service = createMutationService(db, core, { probe: async () => ({ ok: true, value: true }),
    check_github: async () => ({ ok: true, value: true }) });
  const result = await service.pinDefinition({ bundle, authoring: authoring as Parameters<typeof service.pinDefinition>[0]["authoring"] });
  expect({ pinned: result.ok, stored_authoring }).toEqual({ pinned: true, stored_authoring: authoring });
});
