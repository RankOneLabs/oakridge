import { describe, expect, test } from "bun:test";

import { parseWorkflowDefinition as parseDefinition, type AdapterRoleRegistry } from "../src/validation/workflow-definition";
import { AdapterRegistry } from "../src/runtime/executor-registry";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";

const adapterRoles = createDevFlowAdapterRegistry();
const parseWorkflowDefinition = (input: unknown, registry: AdapterRoleRegistry = adapterRoles) => parseDefinition(input, registry);

/** A minimal delegated-session config; tests override only what they exercise. */
const delegatedConfig = (fan_out: unknown) => ({
  prompt_matrix: ["initial", "operator_retry", "input_revision"].map((launch_reason) => ({ session_role: "build", launch_reason, template_path: "p.md" })),
  role_configs: [{ session_role: "build", runtime: "claude-code", session_name: "s", authorized_outputs: ["out"] }],
  slot_bindings: {}, workdir: { from: "literal", value: "/repo" }, fan_out,
  artifact_productions: [], gates: [], handoffs: [],
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

describe("versioned workflow definition compatibility", () => {
  test("operator roles are adapter-registered names rather than a core enum", () => {
    const definition = { id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db", name: "custom-role", version: 1,
      created_at: "2026-08-14T00:00:00Z", graph: { stages: {
        custom: { stage_type: "stub", operator_role: "custom_reviewer", config: {}, inputs: [], outputs: [{ name: "out", artifact_type: "a" }] },
      }, edges: [] } };
    const registry = new AdapterRegistry();
    expect(parseWorkflowDefinition(definition, registry)).toEqual({ ok: false,
      error: expect.objectContaining({ detail: expect.stringContaining("custom_reviewer") }) });
    registry.register_role("custom_reviewer");
    expect(parseWorkflowDefinition(definition, registry).ok).toBe(true);
  });

  test("decodes persisted singular contracts and preserves their revision route", () => {
    const legacyConfig = (role: "build" | "assessment", terminal: object) => ({ runtime: "claude-code", prompt_template_path: `${role}.md`,
      slot_bindings: {}, workdir: { from: "literal", value: "/repo" }, session_name: role, pre_authorized_tools: [], yolo: false, ...terminal });
    const result = parseWorkflowDefinition({ id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db", name: "legacy", version: 14,
      created_at: "2026-08-14T00:00:00Z", graph: { stages: {
        build: { stage_type: "delegated_session", operator_role: "build", inputs: [], outputs: [{ name: "result", artifact_type: "build" }],
          config: legacyConfig("build", { output_handoff: { output: "result", downstream_role: "assessment", approved_wait: { kind: "review" } } }) },
        assessor: { stage_type: "delegated_session", operator_role: "assessment", inputs: [], outputs: [{ name: "assessment", artifact_type: "assessment" }],
          config: legacyConfig("assessment", { output_gate: { output: "assessment", steps: [{ type: "artifact_approval", actions: ["approve", "request_revision"] }], revision_target: "upstream_handoff" } }) },
      }, edges: [] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.graph.stages.assessor?.config).toEqual(expect.objectContaining({ prompt_matrix: expect.any(Array), role_configs: expect.any(Array) }));
    expect(result.value.graph.transitions).toContainEqual({ trigger: { kind: "operator", stage: "assessor", item: "request_revision" },
      launch: { stage: "build", session_role: "build", launch_reason: "input_revision" } });
  });

  test("parses a declared output attention while keeping it optional", async () => {
    const source = await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json();
    source.graph.stages.provision_repository_refs.outputs[0].attention = "optional";
    const result = parseWorkflowDefinition(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.graph.stages.provision_repository_refs?.outputs[0]?.attention).toBe("optional");
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
      b: { stage_type: "stub", config: {}, inputs: [{ name: "in", artifact_type: "a", delivery: "unit_complete" }], outputs: [{ name: "out", artifact_type: "b" }] },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("does not fan out") }) });
  });

  test("rejects an incremental input on a fan-out driven by something other than an input", () => {
    const result = parseWorkflowDefinition(definitionWith("in", {
      a: producer,
      b: { stage_type: "delegated_session", outputs: [{ name: "out", artifact_type: "b" }], inputs: [{ name: "in", artifact_type: "a", delivery: "unit_complete" }],
        config: delegatedConfig({ over: { from: "context", path: "/repositories" }, unit_id_path: "/unit_id" }) },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ detail: expect.stringContaining("drives nothing") }) });
  });

  test("accepts several incremental inputs when one of them is the fan-out driver", () => {
    const result = parseWorkflowDefinition(definitionWith("driver", {
      a: producer,
      b: { stage_type: "delegated_session", outputs: [{ name: "out", artifact_type: "b" }],
        inputs: [{ name: "driver", artifact_type: "a", delivery: "unit_complete" }, { name: "companion", artifact_type: "a", delivery: "unit_complete" }],
        config: delegatedConfig({ over: { from: "input", input_name: "driver" }, unit_id_path: "/unit_id" }) },
    }));
    expect(result.ok).toBe(true);
  });

  // A unit is satisfied when every required output slot is released; a stage
  // with no outputs would satisfy vacuously and complete without executing.
  test("rejects a stage that declares no outputs", () => {
    const result = parseWorkflowDefinition(definitionWith("in", {
      a: producer,
      b: { stage_type: "stub", config: {}, inputs: [{ name: "in", artifact_type: "a" }], outputs: [] },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ operation: "validate_workflow_graph", detail: "stage 'b' must declare at least one output" }) });
  });
});
