/**
 * Keys that arrive from outside — an HTTP path segment, an edge in an uploaded
 * definition, a gate action name — are looked up against object literals whose
 * prototype answers for `constructor`, `toString` and `__proto__`. Every guard
 * below used to say yes to those names.
 */
import { expect, test } from "bun:test";
import { Hono } from "hono";

import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import { selectAncestorStages } from "../src/compiler/select-resume-stages";
import { hasOwn, readOwn } from "../src/domain/records";
import { selectBuiltInGateDisposition } from "../src/domain/gates";
import { createDomainReadApp } from "../src/http/domain-reads";
import { createOperatorProjectionApp } from "../src/http/operator-projections";
import type { OperatorProjectionRepository } from "../src/storage/postgres-operators";
import { parseWorkflowDefinition } from "../src/validation/workflow-definition";
import { delegatedSessionDefinitionSchema } from "../src/validation/delegated-session";
import { loadDevFlowV14 } from "../src/seed/dev-flow-v14";

const INHERITED = ["constructor", "toString", "__proto__"] as const;

test("a plain lookup answers for inherited names and an own-property lookup does not", () => {
  const record: Record<string, string> = { build: "real" };
  for (const key of INHERITED) {
    expect(Boolean(record[key])).toBe(true);
    expect(hasOwn(record, key)).toBe(false);
    expect(readOwn(record, key)).toBeUndefined();
  }
  expect(readOwn(record, "build")).toBe("real");
});

test("an inherited name is not a resumable stage", async () => {
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  for (const key of INHERITED) {
    const selected = selectAncestorStages(compiled.value, key);
    expect(selected.ok).toBe(false);
  }
});

test("an edge naming an inherited stage is rejected rather than crashing the parser", () => {
  const parsed = parseWorkflowDefinition({
    id: "00000000-0000-4000-8000-000000000000", name: "flow", version: 1, created_at: "2026-08-17T00:00:00Z",
    graph: {
      stages: { build: { stage_type: "stub", config: {}, inputs: [], outputs: [{ name: "result", artifact_type: "dev.result" }] } },
      edges: [{ from: { stage: "constructor", slot: "result" }, to: { stage: "build", slot: "input" } }],
    },
  });
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.detail).toContain("edge references unknown stage");
});

test("an inherited name is not a gate action", () => {
  for (const key of INHERITED) {
    expect(selectBuiltInGateDisposition(key)).toBe("terminal");
    const result = delegatedSessionDefinitionSchema.safeParse({
      runtime: "claude_code", prompt_template_path: "prompts/example.md", slot_bindings: {},
      workdir: { from: "literal" as const, value: "." }, session_name: "example",
      output_gate: { output: "result", steps: [{ type: "artifact_approval" as const, actions: [key] }] },
    });
    expect(result.success).toBe(false);
  }
});

/**
 * These ids live in `uuid` columns, so a malformed one is not a lookup that
 * finds nothing — Postgres rejects it while casting and the route answers 500
 * for an id that simply cannot exist. Every route taking a uuid-shaped id must
 * therefore reject it before the query, not after.
 */
// An empty segment never reaches a param handler — the route simply does not match.
const MALFORMED = ["not-a-uuid", "constructor", "'; DROP TABLE oakridge.artifact --"] as const;

const refuseEveryCall = (operation: string) => new Proxy({}, {
  get: () => async () => { throw new Error(`${operation} must not be queried for an id that cannot exist`); },
});

test("no operator projection route queries on a malformed run id", async () => {
  const app = new Hono().route("/", createOperatorProjectionApp(refuseEveryCall("projections") as OperatorProjectionRepository));
  for (const id of MALFORMED) {
    const encoded = encodeURIComponent(id);
    expect((await app.request(`/runs/${encoded}`)).status).toBe(404);
    expect((await app.request(`/runs/${encoded}/gates`)).status).toBe(200);
    expect((await app.request(`/workflow_runs/${encoded}/archive`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/workflow_runs/${encoded}/unarchive`, { method: "POST" })).status).toBe(404);
  }
});

test("no domain read route queries on a malformed id", async () => {
  const app = new Hono().route("/", createDomainReadApp({
    stages: refuseEveryCall("stages") as never,
    artifacts: refuseEveryCall("artifacts") as never,
    session_holds: refuseEveryCall("session_holds") as never,
  }));
  for (const id of MALFORMED) {
    const encoded = encodeURIComponent(id);
    expect((await app.request(`/stage_instances/${encoded}`)).status).toBe(404);
    expect((await app.request(`/artifacts/${encoded}`)).status).toBe(404);
    expect((await app.request(`/workflow_runs/${encoded}/artifacts`)).status).toBe(200);
  }
});
