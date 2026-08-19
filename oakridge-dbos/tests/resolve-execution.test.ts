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

/**
 * `input_lookup` is `context_lookup` keyed off a named input instead of the run
 * context — the binding that lets a cohort find its own repository in a typed
 * upstream output rather than in an untyped bag.
 */
test("input lookup resolves a value from a collected input keyed by the fan-out item", () => {
  const result = resolveBinding({ from: "input_lookup", input_name: "repository_refs", collection_key_path: "/artifact/repository_key", item_key_path: "/artifact/repository_key", value_path: "/artifact/epic_branch" }, {
    inputs: { repository_refs: [
      { artifact_id: "refs-1" as never, artifact_type: "dev.repository_refs", output_name: "repository_refs", unit_id: "api" as UnitId, body: { repository_key: "api", epic_branch: "epic/api" } },
      { artifact_id: "refs-2" as never, artifact_type: "dev.repository_refs", output_name: "repository_refs", unit_id: "web" as UnitId, body: { repository_key: "web", epic_branch: "epic/web" } },
    ] },
    context: {}, item: { artifact: { repository_key: "web" } },
  });
  expect(result).toEqual({ ok: true, value: "epic/web" });
});

test("input lookup names the input it could not find rather than resolving to nothing", () => {
  const binding = { from: "input_lookup", input_name: "repository_refs", collection_key_path: "/artifact/repository_key", item_key_path: "/artifact/repository_key", value_path: "/artifact/epic_branch" } as const;
  expect(resolveBinding(binding, { inputs: {}, context: {}, item: { artifact: { repository_key: "web" } } }))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "input 'repository_refs' not found" }) });
  expect(resolveBinding(binding, { inputs: { repository_refs: [] }, context: {}, item: null }))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "input lookup used outside fan-out" }) });
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
