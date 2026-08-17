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
import type { WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { createOperatorProjectionApp } from "../src/http/operator-projections";
import type { OperatorProjectionRepository } from "../src/storage/postgres-operators";
import { rerunStage, type StageRerunDependencies } from "../src/runtime/stage-rerun";
import { parseWorkflowDefinition } from "../src/validation/workflow-definition";
import { delegatedSessionDefinitionSchema } from "../src/validation/delegated-session";
import { loadDevFlowV11 } from "../src/seed/dev-flow-v11";

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
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  for (const key of INHERITED) {
    const selected = selectAncestorStages(compiled.value, key);
    expect(selected.ok).toBe(false);
  }
});

const runId = "run-1" as WorkflowRunId;
const rerunDefinition: WorkflowDefinition = {
  id: "definition-1" as WorkflowDefinitionId, name: "flow", version: 1, archived: false, created_at: "2026-08-17T00:00:00Z",
  graph: { stages: { build: { stage_type: "delegated_session", operator_role: "build", config: {}, inputs: [], outputs: [] } }, edges: [] },
};

test("an inherited name is not a rerunnable stage", async () => {
  const dependencies = {
    runs: { async find_by_id() { return { id: runId, workflow_definition_id: rerunDefinition.id, context: {}, archived: false }; } },
    definitions: { async find_by_id() { return rerunDefinition; } },
    attempts: { async find_by_root_workflow_id() { throw new Error("must not reach the attempt lookup"); }, async list_for_run() { return []; }, async insert() {} },
    dbos: { async start_run() { throw new Error("must not start a run for a stage that does not exist"); } },
    now: () => "2026-08-17T00:00:00Z", supersede_attempt: async () => {},
  } as unknown as StageRerunDependencies;
  for (const key of INHERITED) {
    const result = await rerunStage({ run_id: runId, stage_key: key, rerun_id: "command-1" }, dependencies);
    expect(result).toEqual({ ok: false, error: { kind: "stage_not_found", stage_key: key } });
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
 * `get_run` binds the id as `$3::uuid`, so a malformed path segment used to
 * reach Postgres as a cast error and surface as a 500 rather than a 404.
 */
test("a malformed run id is not found rather than a database error", async () => {
  const projections = {
    async get_run() { throw new Error("must not query for an id that cannot exist"); },
  } as unknown as OperatorProjectionRepository;
  const app = new Hono().route("/", createOperatorProjectionApp(projections));
  for (const id of ["not-a-uuid", "constructor", "'; DROP TABLE oakridge.artifact --"]) {
    expect((await app.request(`/runs/${encodeURIComponent(id)}`)).status).toBe(404);
  }
});
