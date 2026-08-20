import { expect, test } from "bun:test";

import { builtInStageTypeCompilers, compileWorkflowDefinition, type StageTypeCompiler } from "../src/compiler/compile-workflow";
import { ok } from "../src/domain/primitives";
import { loadDevFlowV13 } from "../src/seed/dev-flow-v13";

test("compiles unchanged v13 into executor-independent materialization contracts", async () => {
  const loaded = await loadDevFlowV13();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  // Provisioning is the only stage with no inputs, so it is the only source.
  // Spec analysis used to start alongside it and index the run context for a
  // directory; it declares the provisioned refs now, so the branch a planner
  // reasons about is guaranteed to exist before the planner does.
  expect(compiled.value.source_stages).toEqual(["provision_refs"]);
  expect(compiled.value.stages.brief_writer?.materialization.kind).toBe("artifact_collection");
  expect(compiled.value.stages.build?.materialization.kind).toBe("fan_out");
  expect(compiled.value.stages.build?.outputs.find((output) => output.name === "build_result")?.release.kind).toBe("handoff");
  expect(compiled.value.edges.find((edge) => edge.consumer_stage === "build" && edge.consumer_input === "brief")?.delivery).toBe("unit_complete");
});

/**
 * The provisioning stage compiles to one unit per repository, keyed by the
 * repository key, with nothing to review. Its executor type is its stage type,
 * which is the contract by which the registered adapter is found.
 */
test("compiles the provisioning stage into one unreviewed unit per repository", async () => {
  const loaded = await loadDevFlowV13();
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
  const loaded = await loadDevFlowV13();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(compiled.error.detail);
  expect(compiled.value.stages.build?.inputs.find((input) => input.name === "repository_refs"))
    .toEqual({ name: "repository_refs", artifact_type: "dev.repository_refs", optional: false, collect: true, delivery: "producer_complete" });
  expect(compiled.value.edges).toContainEqual({ producer_stage: "provision_refs", producer_output: "repository_refs",
    consumer_stage: "build", consumer_input: "repository_refs", delivery: "producer_complete" });
});

test("accepts a non-session executor through the stage-type compiler registry", async () => {
  const loaded = await loadDevFlowV13();
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
  const compiled = compileWorkflowDefinition(definition, { ...builtInStageTypeCompilers, headless_agent: headlessCompiler });
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.value.stages.only?.executor.executor_type).toBe("headless_agent");
});
