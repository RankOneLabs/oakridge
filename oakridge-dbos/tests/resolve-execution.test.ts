import { expect, test } from "bun:test";
import { resolveBinding, resolveDelegatedExecution } from "../src/compiler/resolve-execution";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";
import type { StageInstanceId, UnitId } from "../src/domain/primitives";
import { loadDevFlowV13 } from "../src/seed/dev-flow-v13";
import { delegatedSessionDefinitionSchema } from "../src/validation/delegated-session";

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

/**
 * A delegated agent is handed its own emit URL as
 * `units/{{UNIT_ID}}/emit/<output>`, so whatever fills that slot *is* the
 * execution's address. A definition left over from before a stage fanned out
 * pinned `UNIT_ID` to the literal "0"; every cohort prompt then carried the same
 * wrong address, and a build agent that did its entire job — branch pushed, PR
 * opened — got `404 execution unit not found` on the one call that records it.
 *
 * The tell was that the worktree and session name came out right: those
 * substitute the unit id directly instead of going through the slot table.
 */
test("a definition cannot rebind the slots that identify the execution", () => {
  const definition: DelegatedSessionDefinitionConfig = {
    runtime: { from: "literal", value: "claude-code" }, prompt_template_path: "dev-flow/build_v2.md",
    slot_bindings: {
      UNIT_ID: { from: "literal", value: "0" },
      STAGE_INSTANCE_ID: { from: "literal", value: "not-the-stage" },
    },
    workdir: { from: "literal", value: "/" }, session_name: "build-{{STAGE_INSTANCE_ID}}-{{UNIT_ID}}",
    fan_out: { over: { from: "input", input_name: "brief" }, unit_id_path: "/unit_id", item_bindings: {}, workdir: { from: "literal", value: "/repo" } },
  };

  const result = resolveDelegatedExecution({
    definition, environment: { inputs: {}, context: {}, item: null },
    unit: { unit_id: "targets_spec_contract" as UnitId, depends_on: [], parameters: { artifact: {} } },
    stage_instance_id: "stage-1" as StageInstanceId,
    prompt_template: "PUT /executors/delegated_session/{{STAGE_INSTANCE_ID}}/units/{{UNIT_ID}}/emit/pr_summary",
  });

  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    rendered_prompt: "PUT /executors/delegated_session/stage-1/units/targets_spec_contract/emit/pr_summary",
  }) });
});

/**
 * The shipped definition is the one that had the stale binding, and it cannot be
 * edited to remove it: workflow definitions are immutable, so changing
 * `dev-flow@13` in place makes `insert_immutable` reject it against any database
 * that already stored v13 — the seed would throw on boot. The binding stays
 * until a version bump retires it, which makes "the resolver ignores it" the
 * guarantee that actually protects a live run.
 *
 * So this resolves the real seeded build stage rather than a fixture.
 */
test("the seeded build stage addresses the unit it is running, not its stale binding", async () => {
  const seeded = await loadDevFlowV13();
  if (!seeded.ok) throw new Error(`seed did not load: ${seeded.error.detail}`);

  const build = seeded.value.graph.stages.build;
  expect(build?.stage_type).toBe("delegated_session");

  // Parsed with the schema the compiler itself uses, rather than asserted with
  // a cast. A cast would let this test claim the seeded stage has a shape it
  // never checked — in the one file whose job is to prove what the shipped
  // definition actually does — and a seed that drifted would surface three
  // stages into a run instead of here.
  const parsed = delegatedSessionDefinitionSchema.safeParse(build?.config);
  if (!parsed.success) throw new Error(`seeded build stage does not parse: ${parsed.error.message}`);
  const definition = parsed.data as DelegatedSessionDefinitionConfig;

  // The binding this fix defends against is still there — that is the point.
  expect(definition.slot_bindings.UNIT_ID).toEqual({ from: "literal", value: "0" });

  // The real stage resolves its workdir and both base branches by looking the
  // cohort's repository up in `repository_refs`, so a faithful environment is
  // the only way to reach the prompt at all.
  const repositoryRefs = [{
    artifact_id: "refs-1" as never, artifact_type: "dev.repository_refs", output_name: "repository_refs",
    unit_id: "pipefitter" as UnitId,
    body: { repository_key: "pipefitter", repository_path: "/repo/pipefitter", base_branch: "epic/target-tier-page", integration_branch: "main" },
  }];
  const cohort = {
    unit_id: "targets_spec_contract",
    artifact: {
      cohort_id: "targets_spec_contract", repository_key: "pipefitter", title: "Spec contract",
      goal: "define the view", files_in_scope: ["docs/spec.md"], decisions_made: [],
      acceptance_criteria: ["spec names the route"], next_action: "edit the spec", depends_on: [],
    },
  };

  const result = resolveDelegatedExecution({
    definition,
    environment: {
      inputs: { brief: repositoryRefs, repository_refs: repositoryRefs },
      context: { oakridge_url: "http://oakridge.test", worker_runtime: "claude-code", worker_model: null, worker_effort: null },
      item: null,
    },
    unit: { unit_id: "targets_spec_contract" as UnitId, depends_on: [], parameters: cohort },
    stage_instance_id: "stage-1" as StageInstanceId,
    prompt_template: "units/{{UNIT_ID}}/emit/pr_summary",
  });

  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    rendered_prompt: "units/targets_spec_contract/emit/pr_summary",
  }) });
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
