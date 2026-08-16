import { expect, test } from "bun:test";
import { resolveBinding, resolveDelegatedExecution } from "../src/compiler/resolve-execution";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { StageInstanceId, UnitId } from "../src/domain/primitives";

test("context lookup resolves repository workdir from the runtime fan-out item", () => {
  const result = resolveBinding({ from: "context_lookup", collection_path: "/repositories", collection_key_path: "/key", item_key_path: "/artifact/repository_key", value_path: "/path" }, {
    inputs: {}, context: { repositories: [{ key: "web", path: "/repo/web" }] }, item: { artifact: { repository_key: "web" } },
  });
  expect(result).toEqual({ ok: true, value: "/repo/web" });
});

test("production execution resolution retains v11 prompt and runtime semantics", () => {
  const definition: DelegatedSessionDefinitionConfig = {
    runtime: { from: "context", path: "/worker_runtime" }, prompt_template_path: "dev-flow/build_v2.md",
    slot_bindings: { COHORT_TITLE: { from: "literal", value: "" } }, workdir: { from: "literal", value: "/" },
    session_name: "build-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}", model: { from: "context", path: "/worker_model" },
    fan_out: { over: { from: "input", input_name: "brief" }, unit_id_path: "/unit_id", item_bindings: { COHORT_TITLE: { from: "item", path: "/artifact/title" } }, workdir: { from: "context_lookup", collection_path: "/repositories", collection_key_path: "/key", item_key_path: "/artifact/repository_key", value_path: "/path" } },
  };
  const result = resolveDelegatedExecution({ definition, environment: { inputs: {}, context: { worker_runtime: "claude-code", worker_model: "opus", repositories: [{ key: "web", path: "/repo/web" }] }, item: null }, unit: { unit_id: "web" as UnitId, depends_on: [], parameters: { artifact: { title: "Build web", repository_key: "web" } } }, stage_instance_id: "stage-1" as StageInstanceId, prompt_template: "{{COHORT_TITLE}} ({{UNIT_ID}})" });
  expect(result).toEqual({ ok: true, value: expect.objectContaining({ runtime: "claude-code", rendered_prompt: "Build web (web)", workdir: "/repo/web", session_name: "build-stage-1-web", model: "opus" }) });
});

test("a null effort binding preserves the runtime default", () => {
  const definition: DelegatedSessionDefinitionConfig = {
    runtime: { from: "context", path: "/planner_runtime" }, prompt_template_path: "dev-flow/spec_analyzer_v2.md",
    slot_bindings: {}, workdir: { from: "literal", value: "/repo" }, session_name: "spec-{{STAGE_INSTANCE_ID}}",
    model: { from: "context", path: "/planner_model" }, effort: { from: "context", path: "/planner_effort" },
  };

  const result = resolveDelegatedExecution({
    definition,
    environment: { inputs: {}, context: { planner_runtime: "claude-code", planner_model: "opus", planner_effort: null }, item: null },
    unit: { unit_id: "main" as UnitId, depends_on: [], parameters: null },
    stage_instance_id: "stage-1" as StageInstanceId,
    prompt_template: "Analyze",
  });

  expect(result).toEqual({ ok: true, value: expect.objectContaining({ effort: null }) });
});
