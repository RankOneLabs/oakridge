import { expect, test } from "bun:test";
import { isPrDependent, preflightLaunch, prOperationKeys } from "../src/runtime/pr-launch-preflight";
import { readLaunchableCatalog, resolveDefinition, type DefinitionId } from "../src/runtime/definition-store";
import type { WorkflowDefinitionDescriptor } from "../src/core-client/source-types";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const definition_id = "0".repeat(64) as DefinitionId;
function fixture(): WorkflowDefinitionDescriptor {
  return { workflow: "fixture", input: "string", run: { units: { nested: { group: { units: { watch: { stage: "watch" } }, outcome: {} } } }, outcome: {} },
    workers: { watcher: { kind: "code", operation: "repository.prepare", inputs: {}, produces: [] } },
    stages: { watch: { input: "string", artifacts: {}, workers: { watcher: { template: "watcher", overrides: { operation: "pull_request.inspect" } } }, outcome: {} } } };
}
test("PR dependence follows reachable nested units and template overrides", () => {
  expect(prOperationKeys(fixture())).toEqual(["pull_request.inspect"]);
});
test("committed development depends on PR operations; samples do not", () => {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  expect(["development", "review-loop", "fan-out"].map((name) => {
    const definition = resolveDefinition(catalog.value[name].definition_id);
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
test("a refused PR-dependent launch reads only its receipt and never creates a run", async () => {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  let database_accesses = 0;
  const app = new Hono();
  const lookup = { select: () => lookup, where: () => lookup, executeTakeFirst: async () => undefined };
  const db = { selectFrom(table: string) { database_accesses++; expect(table).toBe("authority.ingress_receipt"); return lookup; } };
  installIngress(app, { db, is_operator_request: () => true } as unknown as IngressDependencies);
  const response = await app.request("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: "refused-pr", definition_id: catalog.value.development.definition_id, input: {}, pr_integration: "none" }) });
  expect({ status: response.status, kind: (await response.json()).kind, database_accesses })
    .toEqual({ status: 422, kind: "integration_none", database_accesses: 1 });
});

import { probePrIntegration } from "../src/runtime/compose";
test("gated-review without a URL is unconfigured", async () => {
  expect((await probePrIntegration("gated-review", null)).kind).toBe("unconfigured");
});
test("gated-review on a closed port is unreachable", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const url = server.url.href;
  await server.stop(true);
  expect((await probePrIntegration("gated-review", url)).kind).toBe("unreachable");
});
test("any gated-review HTTP status proves reachability", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  try { expect(await probePrIntegration("gated-review", server.url.href)).toEqual({ kind: "healthy" }); }
  finally { await server.stop(true); }
});
test("github-cli without gh on PATH is unconfigured", async () => {
  const previous = process.env.PATH;
  process.env.PATH = "/nonexistent-pr-probe-test";
  try { expect((await probePrIntegration("github-cli", null)).kind).toBe("unconfigured"); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
test("a stalled gh auth status is killed at the deadline and reported unconfigured", async () => {
  const bin = mkdtempSync(join(tmpdir(), "pr-probe-gh-"));
  const pid_file = join(bin, "pid");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho $$ > "${pid_file}"\nexec sleep 30\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    const health = await probePrIntegration("github-cli", null);
    const pid = Number(readFileSync(pid_file, "utf8").trim());
    let is_alive = true;
    try { process.kill(pid, 0); } catch { is_alive = false; }
    expect({ kind: health.kind, is_alive }).toEqual({ kind: "unconfigured", is_alive: false });
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  }
}, 10_000);
