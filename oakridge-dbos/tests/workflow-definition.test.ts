import { describe, expect, test } from "bun:test";

import { parseWorkflowDefinition } from "../src/validation/workflow-definition";

describe("Rust v2 workflow definition compatibility", () => {
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
});
