import { describe, expect, test } from "bun:test";

import { parseWorkflowDefinition } from "../src/validation/workflow-definition";

/** A minimal delegated-session config; tests override only what they exercise. */
const delegatedConfig = (fan_out: unknown) => ({
  runtime: "claude-code", prompt_template_path: "p.md", slot_bindings: {},
  workdir: { from: "literal", value: "/repo" }, session_name: "s", fan_out,
});

/** A two-stage graph with one edge from `a.out` into the named input on `b`. */
const definitionWith = (consumerInput: string, stages: Record<string, unknown>) => ({
  id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db",
  name: "incremental",
  version: 1,
  created_at: "2026-08-14T00:00:00Z",
  graph: { stages, edges: [{ from: { stage: "a", slot: "out" }, to: { stage: "b", slot: consumerInput } }] },
});

const producer = { stage_type: "stub", config: {}, inputs: [], outputs: [{ name: "out", artifact_type: "a" }] };

describe("Rust v2 workflow definition compatibility", () => {
  // v11 is still stored, and runs launched against it still compile it. It has
  // to keep parsing for exactly as long as one of those runs is in flight.
  test("loads unmodified dev_flow_v11.json with defaults", async () => {
    const source = await Bun.file(new URL("../../oakridge-core/examples/dev_flow_v11.json", import.meta.url)).json();
    const result = parseWorkflowDefinition(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.graph.stages)).toHaveLength(5);
    expect(result.value.graph.stages.build?.inputs[0]?.delivery).toBe("unit_complete");
    expect(result.value.graph.stages.spec_analyzer?.inputs).toEqual([]);
    expect(result.value.archived).toBe(false);
  });

  test("loads unmodified dev_flow_v14.json, provisioning stage included", async () => {
    const source = await Bun.file(new URL("../../oakridge-core/examples/dev_flow_v14.json", import.meta.url)).json();
    const result = parseWorkflowDefinition(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.graph.stages)).toHaveLength(6);
    expect(result.value.graph.stages.provision_refs?.inputs).toEqual([]);
    expect(result.value.graph.stages.build?.inputs.find((input) => input.name === "repository_refs")?.collect).toBe(true);
  });

  test("rejects a provisioning stage whose output is not the refs artifact", () => {
    const result = parseWorkflowDefinition({
      id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db", name: "bad-provisioning", version: 1, created_at: "2026-08-14T00:00:00Z",
      graph: {
        stages: {
          provision: { stage_type: "provision_repository_refs", config: { repositories: { from: "context", path: "/repositories" }, base_branch: { from: "context", path: "/base_branch" } },
            inputs: [], outputs: [{ name: "repository_refs", artifact_type: "dev.plan" }] },
        },
        edges: [],
      },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("must have artifact type 'dev.repository_refs'") }) });
  });

  test("rejects a provisioning stage declaring more than one output", () => {
    const result = parseWorkflowDefinition({
      id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db", name: "bad-provisioning", version: 1, created_at: "2026-08-14T00:00:00Z",
      graph: {
        stages: {
          provision: { stage_type: "provision_repository_refs", config: { repositories: { from: "context", path: "/repositories" }, base_branch: { from: "context", path: "/base_branch" } },
            inputs: [], outputs: [{ name: "repository_refs", artifact_type: "dev.repository_refs" }, { name: "extra", artifact_type: "dev.repository_refs" }] },
        },
        edges: [],
      },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("must declare exactly one output") }) });
  });

  test("rejects an edge with mismatched artifact types", () => {
    const result = parseWorkflowDefinition({
      id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db",
      name: "bad",
      version: 1,
      created_at: "2026-08-14T00:00:00Z",
      graph: {
        stages: {
          a: { stage_type: "stub", config: {}, inputs: [], outputs: [{ name: "out", artifact_type: "a" }] },
          b: { stage_type: "stub", config: {}, inputs: [{ name: "in", artifact_type: "b" }], outputs: [] },
        },
        edges: [{ from: { stage: "a", slot: "out" }, to: { stage: "b", slot: "in" } }],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an incremental input on a stage that does not fan out", () => {
    const result = parseWorkflowDefinition(definitionWith("in", {
      a: producer,
      b: { stage_type: "stub", config: {}, inputs: [{ name: "in", artifact_type: "a", delivery: "unit_complete" }], outputs: [] },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("does not fan out") }) });
  });

  test("rejects an incremental input on a fan-out driven by something other than an input", () => {
    const result = parseWorkflowDefinition(definitionWith("in", {
      a: producer,
      b: { stage_type: "delegated_session", outputs: [], inputs: [{ name: "in", artifact_type: "a", delivery: "unit_complete" }],
        config: delegatedConfig({ over: { from: "context", path: "/repositories" }, unit_id_path: "/unit_id" }) },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("drives nothing") }) });
  });

  test("accepts several incremental inputs when one of them is the fan-out driver", () => {
    const result = parseWorkflowDefinition(definitionWith("driver", {
      a: producer,
      b: { stage_type: "delegated_session", outputs: [],
        inputs: [{ name: "driver", artifact_type: "a", delivery: "unit_complete" }, { name: "companion", artifact_type: "a", delivery: "unit_complete" }],
        config: delegatedConfig({ over: { from: "input", input_name: "driver" }, unit_id_path: "/unit_id" }) },
    }));
    expect(result.ok).toBe(true);
  });
});
