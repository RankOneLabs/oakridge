import { expect, test } from "bun:test";

import { compileWorkflowDefinition, type StageTypeCompiler } from "../src/compiler/compile-workflow";
import { ok } from "../src/domain/primitives";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";

test("compiles plural v15 into executor-independent materialization contracts", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  // Provisioning is the only stage with no inputs, so it is the only source.
  // Spec analysis used to start alongside it and index the run context for a
  // directory; it declares the provisioned refs now, so the branch a planner
  // reasons about is guaranteed to exist before the planner does.
  expect(compiled.value.source_stages).toEqual(["provision_refs"]);
  expect(compiled.value.stages.brief_writer?.materialization.kind).toBe("artifact_collections");
  expect(compiled.value.stages.build?.materialization.kind).toBe("fan_out");
  expect(compiled.value.stages.build?.outputs.find((output) => output.name === "build_result")?.release.kind).toBe("handoff");
  expect(compiled.value.edges.find((edge) => edge.consumer_stage === "build" && edge.consumer_input === "brief")?.delivery).toBe("unit_complete");
  expect(compiled.value.transitions).toContainEqual({ trigger: { kind: "operator", stage: "assessor", item: "request_revision" },
    launch: { stage: "build", session_role: "build", launch_reason: "input_revision" } });
});

/**
 * The provisioning stage compiles to one unit per repository, keyed by the
 * repository key, with nothing to review. Its executor type is its stage type,
 * which is the contract by which the registered adapter is found.
 */
test("compiles the provisioning stage into one unreviewed unit per repository", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const provisioning = compiled.value.stages.provision_refs;
  expect(provisioning?.executor.executor_type).toBe("provision_repository_refs");
  expect(provisioning?.materialization).toEqual({ kind: "fan_out", over: { from: "context", path: "/repositories" },
    unit_id_path: "/key", depends_on_path: null, max_parallel: 4, manual_admission: false });
  expect(provisioning?.outputs).toEqual([{ name: "repository_refs", artifact_type: "dev.repository_refs", release: { kind: "immediate" } }]);
});

/**
 * Build declares the refs it needs, so the graph — not a convention — is what
 * orders provisioning before it. This edge is the whole fix in one assertion.
 */
test("build declares the provisioned refs as a required input", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  expect(compiled.value.stages.build?.inputs.find((input) => input.name === "repository_refs"))
    .toEqual({ name: "repository_refs", artifact_type: "dev.repository_refs", optional: false, collect: true, delivery: "producer_complete" });
  expect(compiled.value.edges).toContainEqual({ producer_stage: "provision_refs", producer_output: "repository_refs",
    consumer_stage: "build", consumer_input: "repository_refs", delivery: "producer_complete" });
});

test("accepts a non-session executor through the stage-type compiler registry", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const headlessCompiler: StageTypeCompiler = {
    compile: (_stageKey, config) => ok({
      definition_config: config,
      materialization: { kind: "scalar" },
      output_release: () => ({ kind: "immediate" }),
    }),
  };
  const definition = {
    ...loaded.value,
    graph: {
      stages: {
        only: {
          ...loaded.value.graph.stages.spec_analyzer!,
          stage_type: "headless_agent",
          config: { agent: "future-lbc" },
          inputs: [],
        },
      },
      edges: [],
    },
  };
  const compiled = compileWorkflowDefinition(definition, { headless_agent: headlessCompiler });
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.value.stages.only?.executor.executor_type).toBe("headless_agent");
});

test("rejects required attention on an immediate output", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const provision = loaded.value.graph.stages.provision_refs!;
  const definition = {
    ...loaded.value,
    graph: { ...loaded.value.graph, stages: { ...loaded.value.graph.stages,
      provision_refs: { ...provision, outputs: provision.outputs.map((output) => ({ ...output, attention: "required" as const })) } } },
  };
  expect(compileWorkflowDefinition(definition)).toEqual({ ok: false, error: {
    operation: "compile_workflow", stage_key: "provision_refs",
    detail: "output 'repository_refs' declares required attention but continues immediately",
  } });
});

test("accepts no attention on a waiting handoff", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const build = loaded.value.graph.stages.build!;
  const definition = {
    ...loaded.value,
    graph: { ...loaded.value.graph, stages: { ...loaded.value.graph.stages,
      build: { ...build, outputs: build.outputs.map((output) => output.name === "build_result" ? { ...output, attention: "none" as const } : output) } } },
  };
  const compiled = compileWorkflowDefinition(definition);
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.value.stages.build?.outputs.find((output) => output.name === "build_result")?.attention).toBe("none");
});

test("the manifest pipeline reports placeholder, output, and tool failures together", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const build = structuredClone(loaded.value.graph.stages.build!) as any;
  build.config.role_configs[0].session_name = "build-{{MISSING}}";
  build.config.role_configs[0].required_tools = ["forge"];
  build.config.role_configs[0].authorized_outputs.push("ghost");
  const compiled = compileWorkflowDefinition({ ...loaded.value, graph: { ...loaded.value.graph,
    stages: { ...loaded.value.graph.stages, build } } });
  expect(compiled.ok).toBe(false);
  if (compiled.ok) return;
  expect(compiled.error.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "unbound_placeholder", stage_key: "build", placeholder: "MISSING" }),
    expect.objectContaining({ kind: "undeclared_output", stage_key: "build", output: "ghost" }),
    expect.objectContaining({ kind: "unavailable_tool", stage_key: "build", tool: "forge" }),
  ]));
});

test("a schema-invalid stage config joins the all-at-once diagnostic report", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const build = structuredClone(loaded.value.graph.stages.build!) as any;
  build.config.role_configs[0].session_name = "build-{{MISSING}}";
  const assessor = structuredClone(loaded.value.graph.stages.assessor!) as any;
  delete assessor.config.prompt_matrix;
  const compiled = compileWorkflowDefinition({ ...loaded.value, graph: { ...loaded.value.graph,
    stages: { ...loaded.value.graph.stages, build, assessor } } });
  expect(compiled.ok).toBe(false);
  if (compiled.ok) return;
  expect(compiled.error.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "unbound_placeholder", stage_key: "build", placeholder: "MISSING" }),
    expect.objectContaining({ kind: "invalid_stage_config", stage_key: "assessor", contract_item: "config" }),
  ]));
});

test("automated assessment transitions are visible manifest flags without rejecting compilation", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const transition = { trigger: { kind: "assessment_outcome" as const, stage: "assessor", item: "approved" },
    launch: { stage: "build", session_role: "build" as const, launch_reason: "input_revision" as const } };
  const compiled = compileWorkflowDefinition({ ...loaded.value, graph: { ...loaded.value.graph, transitions: [transition] } });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(compiled.value.flags).toContainEqual(expect.objectContaining({
    kind: "automated_assessment_transition", stage_key: "build", trigger: "approved",
  }));
});
