import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compileV15WorkflowDefinition, v15PromptReferences } from "../src/compiler/compile-v15";
import { parseV15WorkflowDefinition } from "../src/validation/v15-definition";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { createPromptTemplateLoader } from "../src/runtime/prompt-template";
import { artifactRefFromRevision, V15_WORKER_KEYS, V15_FACTS, V15_CHANGE_KINDS, type V15DecisionTree, type WorkflowDefinition } from "../src/domain/dev-flow-v15";
import type { ArtifactId } from "../src/domain/primitives";

const definition = async (): Promise<WorkflowDefinition> => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  return structuredClone(loaded.value);
};
const withTree = (source: WorkflowDefinition, tree: unknown) => ({ ...source, stages: { ...source.stages,
  implementation: { ...source.stages.implementation, cohort: { ...source.stages.implementation.cohort, decision_tree: tree } },
} });
const check = (source: unknown) => {
  const parsed = parseV15WorkflowDefinition(source);
  return parsed.ok ? "valid" : parsed.error.kind;
};

test("the shipped definition equals the committed authority and compiles all eighteen prompts", async () => {
  const source = await definition();
  expect(source).toEqual(await Bun.file(new URL("../../docs/v15-contracts/oakridge-v15-workflow-definition.json", import.meta.url)).json());
  const compiled = await compileV15WorkflowDefinition(source, createPromptTemplateLoader(resolve(import.meta.dir, "../..")));
  if (!compiled.ok) throw new Error(compiled.error.detail);
  expect(compiled.value.prompts.entries).toHaveLength(18);
});

test("the checked worker vocabulary covers all seven contract workers", () => {
  expect(V15_WORKER_KEYS).toEqual(["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"]);
});
test("all workflow readiness and interruption facts are present", () => {
  expect(V15_FACTS).toEqual(expect.arrayContaining(["provision_outputs_ready", "provision_failed", "provision_execution_interrupted", "spec_outputs_ready", "spec_execution_interrupted", "plan_outputs_ready", "plan_execution_interrupted", "brief_outputs_ready", "brief_execution_interrupted", "final_outputs_ready", "final_execution_interrupted", "final_pr_merged_at_reviewed_head", "final_pr_closed_unmerged"]));
});
test("the change vocabulary includes fencing and independent acceptance", () => {
  expect(V15_CHANGE_KINDS).toEqual(expect.arrayContaining(["clear_acceptance", "fence_execution", "capture_accepted_build", "clear_accepted_build"]));
});
test("artifact references use the revision chain and content revision", () => {
  expect(artifactRefFromRevision({ chain_id: "chain" as ArtifactId, revision: 3 })).toEqual({ id: "chain" as ArtifactId, version: 3 });
});

test("an action cannot declare both a prompt and operation", async () => {
  const source = await definition();
  Object.assign(source.stages.spec_analysis.cohort.workers.spec.action_points.initial, { operation: "provision_repository_refs" });
  expect(check(source)).toBe("action_ambiguous");
});
test("an action cannot omit its execution target", async () => {
  const source = await definition();
  Reflect.deleteProperty(source.stages.spec_analysis.cohort.workers.spec.action_points.initial, "prompt");
  expect(check(source)).toBe("action_missing");
});
test("a known source belonging to another worker is unavailable", async () => {
  const source = await definition();
  source.stages.spec_analysis.cohort.workers.spec.action_points.initial.inputs.brief_notes.from = "build.interrupted.work";
  expect(check(source)).toBe("source_unavailable");
});
test("an available source must match the destination field type", async () => {
  const source = await definition();
  source.stages.spec_analysis.cohort.workers.spec.action_points.initial.inputs.brief_notes.from = "inputs.repositories";
  expect(check(source)).toBe("source_type_mismatch");
});
test("bindings must cover every payload field", async () => {
  const source = await definition();
  Reflect.deleteProperty(source.stages.spec_analysis.cohort.workers.spec.action_points.initial.inputs, "repositories");
  expect(check(source)).toBe("payload_coverage");
});
test("bindings reject surplus payload fields", async () => {
  const source = await definition();
  Object.assign(source.stages.spec_analysis.cohort.workers.spec.action_points.initial.inputs, { extra: { from: "inputs.brief_notes" } });
  expect(check(source)).toBe("payload_coverage");
});
test("a match cannot inspect another cohort's worker", async () => {
  const source = await definition();
  expect(check(withTree(source, { kind: "match_worker", worker: "spec", cases: {}, otherwise: { kind: "wait", reason: "waiting" } }))).toBe("worker_outside_cohort");
});
test("a leaf cannot name an undeclared action point", async () => {
  expect(check(withTree(await definition(), { kind: "apply", changes: [], actions: [{ worker: "build", action_point: "invented" }] }))).toBe("action_point_undeclared");
});
test("retry input is unavailable without an interrupted-worker branch", async () => {
  expect(check(withTree(await definition(), { kind: "apply", changes: [{ kind: "set_worker_state", worker: "build", state: "working" }], actions: [{ worker: "build", action_point: "retry" }] }))).toBe("source_unavailable");
});
test("a launch cannot omit the worker's working state", async () => {
  expect(check(withTree(await definition(), { kind: "match_cohort", cases: { pending: {
    kind: "apply", changes: [], actions: [{ worker: "build", action_point: "initial" }],
  } }, otherwise: { kind: "wait", reason: "working" } }))).toBe("contradictory_changes");
});
test("stage prerequisites cannot omit required artifact producers", async () => {
  const source = await definition();
  source.stages.planning.prerequisites = [];
  expect(check(source)).toBe("invalid_prerequisites");
});
test("required producers may be reached through transitive prerequisites", async () => {
  const source = await definition();
  source.stages.planning.prerequisites = ["spec_analysis"];
  expect(check(source)).toBe("valid");
});
test("a leaf cannot write conflicting worker states", async () => {
  expect(check(withTree(await definition(), { kind: "apply", changes: [{ kind: "set_worker_state", worker: "build", state: "accepted" }, { kind: "set_worker_state", worker: "build", state: "cancelled" }], actions: [] }))).toBe("contradictory_changes");
});
test("a leaf cannot both capture and clear the accepted build", async () => {
  expect(check(withTree(await definition(), { kind: "apply", changes: [{ kind: "capture_accepted_build" }, { kind: "clear_accepted_build" }], actions: [] }))).toBe("contradictory_changes");
});
test("unsupported top-level fields are rejected", async () => {
  expect(check({ ...await definition(), machines: {} })).toBe("unknown_field");
});
test("unsupported worker fields are rejected", async () => {
  const source = await definition();
  Object.assign(source.stages.implementation.cohort.workers.build, { fan_out: {} });
  expect(check(source)).toBe("unknown_field");
});
test("every match requires an explicit fallback", async () => {
  expect(check(withTree(await definition(), { kind: "match_request", cases: {} }))).toBe("invalid_shape");
});
test("every conditional requires both branches", async () => {
  expect(check(withTree(await definition(), { kind: "if", fact: "build_outputs_ready", then: { kind: "wait", reason: "waiting" } }))).toBe("invalid_shape");
});
test("a cyclic object tree is rejected without recursive traversal", async () => {
  const tree: { kind: "match_cohort"; cases: { pending?: unknown }; otherwise: V15DecisionTree } = { kind: "match_cohort", cases: {}, otherwise: { kind: "wait", reason: "waiting" } };
  tree.cases.pending = tree;
  expect(check(withTree(await definition(), tree))).toBe("cyclic_tree");
});
test("stage prerequisites cannot form a cycle", async () => {
  const source = await definition();
  source.stages.repository_preparation.prerequisites = ["final_integration"];
  expect(check(source)).toBe("invalid_prerequisites");
});
test("a missing committed prompt is a typed compile failure", async () => {
  const compiled = await compileV15WorkflowDefinition(await definition(), { async load() { throw new Error("missing file"); } });
  expect(compiled).toEqual({ ok: false, error: expect.objectContaining({ kind: "prompt_unavailable" }) });
});
test("an action cannot reuse another action's prompt", async () => {
  const source = await definition();
  source.stages.implementation.cohort.workers.build.action_points.revise.prompt = source.stages.implementation.cohort.workers.build.action_points.initial.prompt;
  const compiled = await compileV15WorkflowDefinition(source, createPromptTemplateLoader(resolve(import.meta.dir, "../..")));
  expect(compiled).toEqual({ ok: false, error: expect.objectContaining({ kind: "prompt_totality" }) });
});
test("the live prompt directory contains exactly the declared eighteen files", async () => {
  const declared = v15PromptReferences(await definition()).map((entry) => entry.path).sort();
  const actual = [...new Bun.Glob("**/*.md").scanSync({ cwd: resolve(import.meta.dir, "../../workflow-config/prompts/dev-flow/v15") })].map((path) => `workflow-config/prompts/dev-flow/v15/${path}`).sort();
  expect(actual).toEqual(declared);
});


// Read authored JSON directly: this independently checks every shipped tree,
// rather than treating validator acceptance as proof of these properties.
test("every shipped decision tree is finite with explicit match and conditional branches", async () => {
  const source = await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json() as WorkflowDefinition;
  for (const stage of Object.values(source.stages)) {
    const pending: { tree: V15DecisionTree; ancestors: ReadonlySet<V15DecisionTree> }[] = [
      { tree: stage.cohort.decision_tree, ancestors: new Set() },
    ];
    while (pending.length > 0) {
      const { tree, ancestors } = pending.pop()!;
      expect(tree).toBeDefined();
      expect(ancestors.has(tree)).toBe(false);
      const nextAncestors = new Set([...ancestors, tree]);
      switch (tree.kind) {
        case "match_cohort": case "match_worker": case "match_request":
          expect(Object.hasOwn(tree, "otherwise")).toBe(true);
          pending.push(...[...Object.values(tree.cases), tree.otherwise].map((child) => ({ tree: child!, ancestors: nextAncestors })));
          break;
        case "if":
          expect(Object.hasOwn(tree, "then")).toBe(true);
          expect(Object.hasOwn(tree, "else")).toBe(true);
          pending.push({ tree: tree.then, ancestors: nextAncestors }, { tree: tree.else, ancestors: nextAncestors });
          break;
        case "apply": case "wait": case "reject": break;
        default: throw new Error("Unknown authored tree node");
      }
    }
  }
});

test("all three plan prompts describe the narrowed PlanBody", async () => {
  const prompts = v15PromptReferences(await definition()).filter((reference) => reference.worker === "plan");
  expect(prompts).toHaveLength(3);
  for (const reference of prompts) {
    const content = await Bun.file(resolve(import.meta.dir, "../..", reference.path)).text();
    expect(content).not.toContain("dependency_order");
    expect(content).toContain("`summary`, `cohorts`, `scope`, `acceptance_criteria`, and `risks`");
    expect(content).toContain("`depends_on`");
  }
});
