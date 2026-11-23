import { describe, expect, it } from "vitest";
import captured from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionGraph } from "../operator-contracts/projections/definition-view";
import { selectAgentSessionTargets, selectLaunchSessionSettings, selectRoleChoiceTargets, selectSessionKeysFromRoleKeys,
  selectSessionSelectionsFromRoles } from "./agent-session-targets";

const definition = captured.definition;

const graph = (dependencies: Readonly<Record<string, readonly string[]>>): OperatorDefinitionGraph => ({
  nodes: Object.entries(dependencies).map(([stage, depends_on]) => ({ key: stage, stage, depends_on })),
  edges: Object.entries(dependencies).flatMap(([to, parents]) => parents.map((from) => ({ from, to }))),
});
const developmentGraph = graph({ analysis: [], planning: ["analysis"], brief: ["planning"], cohort: ["brief"], integration: ["cohort"] });
const workerOrder = { cohort: ["builder", "assessor"] };
const targetsForDevelopment = () => selectAgentSessionTargets(definition.workflow, developmentGraph, workerOrder);

describe("agent session choices from a pinned definition", () => {
  it("exposes each agent worker, including builder and assessor separately", () => {
    expect(targetsForDevelopment().map((target) => [target.stage, target.worker])).toEqual([
      ["analysis", "author"], ["analysis", "spec_editor"], ["planning", "planner"], ["brief", "writer"],
      ["cohort", "builder"], ["cohort", "assessor"], ["integration", "integrator"],
    ]);
  });

  it("suggests the worker role for each declared worker", () => {
    const targets = targetsForDevelopment();
    expect(targets.filter((target) => target.stage === "integration" || target.stage === "cohort")
      .map((target) => [target.worker, target.suggested_role]))
      .toEqual([["builder", "worker"], ["assessor", "worker"], ["integrator", "worker"]]);
  });

  it("includes agent template uses and excludes code template uses", () => {
    const source = {
      ...definition.workflow,
      workers: { author_template: { kind: "agent" }, watch_template: { kind: "code" } },
      stages: {
        ...definition.workflow.stages,
        analysis: { workers: { author: { template: "author_template" }, watch: { template: "watch_template" } } },
      },
    };
    expect(selectAgentSessionTargets(source).filter((target) => target.stage === "analysis").map((target) => target.worker))
      .toEqual(["author"]);
  });

  it("creates independent settings for each agent worker", () => {
    const targets = targetsForDevelopment();
    const selections = Object.fromEntries(targets.map((target) => [target.key,
      { runtime: "claude-code" as const, model: target.worker === "assessor" ? "opus" : "sonnet" }]));
    const result = selectLaunchSessionSettings(targets, selections);
    expect(result.ok && [result.value.cohort.assessor, result.value.cohort.builder]).toEqual([
      { harness: "claude-code", model: "opus", effort: null },
      { harness: "claude-code", model: "sonnet", effort: null },
    ]);
  });

  it("keeps dotted stage and worker names distinct", () => {
    const targets = selectAgentSessionTargets({ workflow: "review", stages: {
      "review.writer": { workers: { checker: { kind: "agent" } } },
      review: { workers: { "writer.checker": { kind: "agent" } } },
    } });
    const selections = Object.fromEntries(targets.map((target) => [target.key,
      { runtime: "claude-code" as const, model: target.stage === "review" ? "sonnet" : "opus" }]));
    const result = selectLaunchSessionSettings(targets, selections);
    expect(result.ok && [result.value.review["writer.checker"].model, result.value["review.writer"].checker.model])
      .toEqual(["sonnet", "opus"]);
  });

  it("rejects an incomplete choice before launch", () => {
    const result = selectLaunchSessionSettings(targetsForDevelopment(), {});
    expect(result.ok ? null : result.error.detail).toBe("Choose a runtime and model for analysis · author.");
  });

  it("offers a worker choice covering every agent session", () => {
    expect(selectRoleChoiceTargets(targetsForDevelopment()).map((target) => [target.key, target.covers]))
      .toEqual([
        ["worker", ["analysis · author", "analysis · spec_editor", "planning · planner", "brief · writer", "cohort · builder", "cohort · assessor", "integration · integrator"]],
      ]);
  });

  it("omits a role no session uses", () => {
    const targets = selectAgentSessionTargets({ workflow: "review", stages: { review: { workers: { checker: { kind: "agent" } } } } });
    expect(selectRoleChoiceTargets(targets).map((target) => target.key)).toEqual(["worker"]);
  });

  it("launches every session with its role's model when choosing by role", () => {
    const targets = targetsForDevelopment();
    const selections = selectSessionSelectionsFromRoles(targets, {
      planner: { runtime: "claude-code", model: "opus" },
      worker: { runtime: "codex", model: "gpt-5" },
    });
    const result = selectLaunchSessionSettings(targets, selections);
    expect(result.ok && [result.value.cohort.builder.model, result.value.cohort.assessor.model, result.value.integration.integrator.model])
      .toEqual(["gpt-5", "gpt-5", "gpt-5"]);
  });

  it("marks a session's runtime as chosen when its role's runtime was chosen", () => {
    const targets = targetsForDevelopment();
    expect([...selectSessionKeysFromRoleKeys(targets, new Set(["worker"]))]).toEqual(targets.map(({ key }) => key));
  });
});

it("orders study targets by graph depth, then declaration order within a stage", () => {
  const agent = { kind: "agent" };
  const study = { workflow: "study", stages: {
    freeze: { workers: { freezer: agent } }, integration: { workers: { integrator: agent } },
    design: { workers: { slice_assessor: agent, designer: agent, slice_builder: agent, slice_runner: agent } },
    expand: { workers: { expander: agent } },
  } };
  const ordered = selectAgentSessionTargets(study, graph({ design: [], expand: ["design"], freeze: ["expand"], integration: ["freeze"] }),
    { design: ["designer", "slice_builder", "slice_runner", "slice_assessor"] });
  expect([...new Set(ordered.map(({ stage }) => stage))]).toEqual(["design", "expand", "freeze", "integration"]);
  expect(ordered.filter(({ stage }) => stage === "design").map(({ worker }) => worker))
    .toEqual(["designer", "slice_builder", "slice_runner", "slice_assessor"]);
});
