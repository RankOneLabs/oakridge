import { expect, test } from "bun:test";
import { Hono } from "hono";
import { installDefinitionApi } from "../src/http/app";
import type { CoreClient } from "../src/core-client/client";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const authoring = { authoring_version: 1, template: "development", key: "development",
  implementation_capacity: 4, sibling_failure: "cancel", wire_field_order: "canonical", stage_layout: "standard" };

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
