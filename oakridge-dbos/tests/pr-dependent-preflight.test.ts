import { expect, test } from "bun:test";
import { isPrDependent, preflightLaunch, prOperationKeys } from "../src/domain/pr-integration";
import { readLaunchableCatalog, resolveDefinition, type DefinitionId } from "../src/runtime/definition-store";
import type { WorkflowDefinitionDescriptor } from "../src/core-client/source-types";
const definition_id = "0".repeat(64) as DefinitionId;
function fixture(): WorkflowDefinitionDescriptor {
  return { workflow: "fixture", input: "string", run: { units: { nested: { group: { units: { watch: { stage: "watch" } }, outcome: {} } } }, outcome: {} },
    workers: { watcher: { kind: "code", operation: "repository.prepare", inputs: {}, produces: [] } },
    stages: { watch: { input: "string", artifacts: {}, workers: { watcher: { template: "watcher", overrides: { operation: "pull_request.observe" } } }, outcome: {} } } };
}
test("PR dependence follows reachable nested units and template overrides", () => {
  expect(prOperationKeys(fixture())).toEqual(["pull_request.observe"]);
});
test("committed development depends on PR operations; samples do not", () => {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  expect(["development", "review-loop", "fan-out"].map((name) => {
    const definition = resolveDefinition(catalog.value[name]!);
    if (!definition.ok) throw new Error(JSON.stringify(definition.error));
    return isPrDependent(definition.value.source);
  })).toEqual([true, false, false]);
});
test("PR preflight refuses the selected integration without fallback", () => {
  const definition = { definition_id, source: fixture() };
  expect([
    preflightLaunch({ definition, integration: "none", health: { kind: "healthy" } }),
    preflightLaunch({ definition, integration: "gated-review", health: { kind: "unconfigured", detail: "no URL" } }),
    preflightLaunch({ definition, integration: "gated-review", health: { kind: "unreachable", detail: "closed port" } }),
    preflightLaunch({ definition, integration: "github-cli", health: { kind: "unconfigured", detail: "no gh" } }),
  ].map((result) => result.ok ? null : [result.error.kind, result.error.integration])).toEqual([
    ["integration_none", "none"], ["integration_unconfigured", "gated-review"],
    ["integration_unreachable", "gated-review"], ["integration_unconfigured", "github-cli"],
  ]);
});
test("non-PR definitions ignore integration health", () => {
  const source = { ...fixture(), run: { units: {}, outcome: {} } };
  expect(preflightLaunch({ definition: { definition_id, source }, integration: "none", health: { kind: "unreachable", detail: "offline" } }).ok).toBe(true);
});

import { Hono } from "hono";
import { installIngress, type IngressDependencies } from "../src/http/ingress";
test("a refused PR-dependent launch never reaches the authority database", async () => {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  let database_accesses = 0;
  const app = new Hono();
  const db = new Proxy({}, { get() { database_accesses++; throw new Error("unexpected database access"); } });
  installIngress(app, { db, is_operator_request: () => true } as unknown as IngressDependencies);
  const response = await app.request("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: "refused-pr", definition_id: catalog.value.development, input: {}, pr_integration: "none" }) });
  expect({ status: response.status, kind: (await response.json()).kind, database_accesses })
    .toEqual({ status: 422, kind: "integration_none", database_accesses: 0 });
});
