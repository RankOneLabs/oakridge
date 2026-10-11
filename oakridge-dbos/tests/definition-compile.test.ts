import { expect, test } from "bun:test";
import { Hono } from "hono";
import { resolve } from "node:path";
import { installDefinitionApi } from "../src/http/app";
import { createMutationService } from "../src/storage/mutation-service";
import type { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const authoring = { authoring_version: 1, template: "development", key: "development",
  implementation_capacity: 4, sibling_failure: "cancel", wire_field_order: "canonical", stage_layout: "standard" };
const bundle: DefinitionBundle = await Bun.file(
  resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();

function definitionApi(overrides: {
  readonly db?: TransactionalSqlExecutor;
  readonly mutations?: MutationService;
} = {}): Hono {
  const app = new Hono();
  installDefinitionApi(app, {
    db: overrides.db ?? ({} as TransactionalSqlExecutor),
    core: {} as CoreClient,
    mutations: overrides.mutations ?? ({} as MutationService),
    wake: async () => {},
  });
  return app;
}

// The v1 template builder is retired with its authoring surface, so both
// authored entry points answer with the reason rather than building a bundle.
for (const path of ["/api/definitions/compile", "/api/definitions"]) {
  test(`${path} reports that v1 template authoring is retired`, async () => {
    const response = await definitionApi().request(path, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(authoring) });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 422,
      body: { error: "v1 template authoring is retired; pin a compiled workflow instead", field_path: "authoring" },
    });
  });
}

test("a raw compiled bundle still pins without authoring", async () => {
  let pinned: unknown = null;
  const mutations = { async pinDefinition(request: { bundle: DefinitionBundle }) {
    pinned = request.bundle.key;
    return { ok: true, value: { bundle_id: "bundle-1" } };
  } } as unknown as MutationService;
  const response = await definitionApi({ mutations }).request("/api/definitions", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
  expect({ status: response.status, pinned }).toEqual({ status: 201, pinned: bundle.key });
});

test("definition detail returns saved authoring and a dependency graph", async () => {
  const db = { query: async () => [{ bundle_id: "bundle-1", digest: "digest", source: bundle, archived_at: null, authoring }] } as unknown as TransactionalSqlExecutor;
  const response = await definitionApi({ db }).request("/api/definitions/bundle-1");
  const detail = await response.json() as { authoring: unknown; graph: { nodes: readonly { key: string }[]; edges: readonly { from: string; to: string }[] } };
  expect({ status: response.status, authoring: detail.authoring, prepare: detail.graph.nodes[0]?.key,
    first_dependency: detail.graph.edges[0] })
    .toEqual({ status: 200, authoring, prepare: "prepare", first_dependency: { from: "prepare", to: "analysis" } });
});

test("prompt catalog endpoint returns generated prompt keys with server digests", async () => {
  const response = await definitionApi().request("/api/prompts");
  const prompts = await response.json() as readonly { key: string; path: string; content_digest: string }[];
  expect({ status: response.status, generated: prompts.filter((prompt) => prompt.key.endsWith("_v3")).length,
    has_digest: prompts.every((prompt) => /^[0-9a-f]{64}$/.test(prompt.content_digest)) })
    .toEqual({ status: 200, generated: 21, has_digest: true });
});

test("pinning persists the authored value alongside the compiled bundle", async () => {
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

test("pinning enriches an existing definition and invalidates its projection once", async () => {
  let stored_authoring: unknown = null;
  const invalidated: string[] = [];
  const query = async (statement: string, parameters: readonly unknown[]) => {
    if (statement.startsWith("INSERT INTO authority.definition_bundle")) return [];
    if (statement.startsWith("UPDATE authority.definition_bundle")) {
      if (stored_authoring !== null) return [];
      stored_authoring = JSON.parse(String(parameters[1]));
      return [{ id: "existing-bundle" }];
    }
    if (statement.startsWith("INSERT INTO authority.operator_event")) invalidated.push(String(parameters[2]));
    if (statement.includes("FROM authority.definition_bundle"))
      return [{ bundle_id: "existing-bundle", digest: "compiled", source: bundle, authoring: stored_authoring, archived_at: null }];
    return [];
  };
  const db = { query, transaction: async (operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }) } as unknown as TransactionalSqlExecutor;
  const core = { request: async () => ({ ok: true, value: { kind: "compiled", value: { digest: "compiled", scopes: [] } } }) } as unknown as CoreClient;
  const service = createMutationService(db, core, { probe: async () => ({ ok: true, value: true }),
    check_github: async () => ({ ok: true, value: true }) });
  const request = { bundle, authoring: authoring as Parameters<typeof service.pinDefinition>[0]["authoring"] };
  const first = await service.pinDefinition(request);
  const second = await service.pinDefinition(request);
  expect({ first: first.ok, second: second.ok, stored_authoring, invalidated })
    .toEqual({ first: true, second: true, stored_authoring: authoring, invalidated: ["existing-bundle"] });
});
