import { expect, test } from "bun:test";

import { builtInStageTypeCompilers, compileWorkflowDefinition, type StageTypeCompiler } from "../src/compiler/compile-workflow";
import { ok } from "../src/domain/primitives";
import { loadDevFlowV11 } from "../src/seed/dev-flow-v11";

test("compiles unchanged v11 into executor-independent materialization contracts", async () => {
  const loaded = await loadDevFlowV11();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(compiled.value.source_stages).toEqual(["spec_analyzer"]);
  expect(compiled.value.stages.brief_writer?.materialization.kind).toBe("artifact_collection");
  expect(compiled.value.stages.build?.materialization.kind).toBe("fan_out");
  expect(compiled.value.stages.build?.outputs.find((output) => output.name === "build_result")?.release.kind).toBe("handoff");
  expect(compiled.value.edges.find((edge) => edge.consumer_stage === "build")?.delivery).toBe("unit_complete");
});

test("accepts a non-session executor through the stage-type compiler registry", async () => {
  const loaded = await loadDevFlowV11();
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
