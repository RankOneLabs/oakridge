import { expect, test } from "bun:test";

import { contextRequirementsOf, describeUnsatisfiedRequirements, unsatisfiedContextRequirements } from "../src/compiler/context-requirements";
import type { RunContext } from "../src/domain/run-context";
import type { WorkflowGraph } from "../src/domain/workflow";

const graphOf = (stages: Readonly<Record<string, unknown>>): WorkflowGraph => ({
  stages: Object.fromEntries(Object.entries(stages).map(([key, config]) => [key,
    { stage_type: "delegated_session", operator_role: null, config, inputs: [], outputs: [] }])),
  edges: [],
} as unknown as WorkflowGraph);

const pointers = (graph: WorkflowGraph): readonly string[] => contextRequirementsOf(graph).map((requirement) => requirement.pointer);

test("a context binding is found wherever a delegated session carries one", () => {
  const graph = graphOf({
    build: {
      runtime: { from: "context", path: "/worker_runtime" },
      model: { from: "context", path: "/worker_model" },
      slot_bindings: { OAKRIDGE_URL: { from: "context", path: "/oakridge_url" } },
      workdir: { from: "context", path: "/repositories/0/path" },
      fan_out: {
        item_bindings: { TITLE: { from: "context", path: "/cohort_title" } },
        worktree: { base_ref: { from: "context", path: "/base_ref" } },
      },
    },
  });
  expect(pointers(graph)).toEqual(["/worker_runtime", "/worker_model", "/oakridge_url", "/repositories/0/path", "/cohort_title", "/base_ref"]);
});

test("bindings that never touch the context contribute no requirement", () => {
  const graph = graphOf({
    build: {
      slot_bindings: {
        FROM_INPUT: { from: "input", input_name: "brief", path: "/artifact/title" },
        FROM_ITEM: { from: "item", path: "/artifact/cohort_id" },
        FROM_LITERAL: { from: "literal", value: "/not-a-pointer" },
        FROM_INPUT_LOOKUP: { from: "input_lookup", input_name: "repository_refs", collection_key_path: "/a", item_key_path: "/b", value_path: "/c" },
      },
    },
  });
  expect(pointers(graph)).toEqual([]);
});

/**
 * A lookup dereferences its collection against the context and nothing else.
 * Which entry it then matches depends on a fan-out item an upstream stage has
 * not produced yet, so claiming the item-side paths as launch requirements
 * would refuse launches that were going to work.
 */
test("a context lookup requires its collection and not the paths it searches with", () => {
  const graph = graphOf({
    build: {
      slot_bindings: {
        BRANCH: { from: "context_lookup", collection_path: "/repositories", collection_key_path: "/key", item_key_path: "/repository_key", value_path: "/epic_branch" },
      },
    },
  });
  expect(pointers(graph)).toEqual(["/repositories"]);
});

test("a pointer several stages read is one requirement, attributed to the first", () => {
  const graph = graphOf({
    spec_analyzer: { slot_bindings: { URL: { from: "context", path: "/oakridge_url" } } },
    plan_writer: { slot_bindings: { URL: { from: "context", path: "/oakridge_url" } } },
  });
  expect(contextRequirementsOf(graph)).toEqual([{ pointer: "/oakridge_url", stage_key: "spec_analyzer" }]);
});

/**
 * The walk recognises a binding by its own schema rather than by the position a
 * particular stage type keeps it in, so a stage type with a config shape of its
 * own is covered without the walker being taught about it.
 */
test("a stage type with its own config shape is walked too", () => {
  const graph = {
    stages: { provision_refs: { stage_type: "provision_repository_refs", operator_role: null, inputs: [], outputs: [],
      config: { repositories: { from: "context", path: "/repositories" }, max_parallel: 4 } } },
    edges: [],
  } as unknown as WorkflowGraph;
  expect(pointers(graph)).toEqual(["/repositories"]);
});

test("an absent pointer is unsatisfied and a present one is not", () => {
  const graph = graphOf({ build: { slot_bindings: {
    URL: { from: "context", path: "/oakridge_url" },
    NOTES: { from: "context", path: "/brief_notes" },
  } } });
  const context: RunContext = { oakridge_url: "http://oakridge" };
  expect(unsatisfiedContextRequirements(context, contextRequirementsOf(graph)).map((r) => r.pointer)).toEqual(["/brief_notes"]);
});

/**
 * The flow sends `planner_effort: null` to mean "the runtime's default", and the
 * binding resolver accepts it. A launch check that tested truthiness rather than
 * presence would refuse a launch that was going to run.
 */
test("an explicitly null value satisfies the requirement that reads it", () => {
  const graph = graphOf({ build: { effort: { from: "context", path: "/planner_effort" } } });
  expect(unsatisfiedContextRequirements({ planner_effort: null }, contextRequirementsOf(graph))).toEqual([]);
});

test("a refusal names every unmet pointer and the stage that wanted it", () => {
  expect(describeUnsatisfiedRequirements([
    { pointer: "/oakridge_url", stage_key: "spec_analyzer" },
    { pointer: "/worker_model", stage_key: "build" },
  ])).toBe("/oakridge_url (spec_analyzer), /worker_model (build)");
});

/**
 * The transform against the definition that actually ships. This is the test
 * that would have caught the launches the operator lost three days to: every
 * pointer here was a stage failing mid-run when the context did not carry it.
 */
test("the shipped dev-flow definition demands exactly the keys the launcher sends", async () => {
  const definition = await Bun.file(new URL("../../oakridge-core/examples/dev_flow_v13.json", import.meta.url)).json() as { readonly graph: WorkflowGraph };
  expect([...pointers(definition.graph)].sort()).toEqual([
    // The run's one base branch. Its predecessor was `/repositories/0/path` —
    // an index into the context standing in for a branch nobody had named.
    "/base_branch",
    "/brief_notes",
    "/oakridge_url",
    "/planner_effort",
    "/planner_model",
    "/planner_runtime",
    "/repositories",
    "/worker_effort",
    "/worker_model",
    "/worker_runtime",
  ]);
});
