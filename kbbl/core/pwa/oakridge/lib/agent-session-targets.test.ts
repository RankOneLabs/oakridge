import { describe, expect, it } from "vitest";
import captured from "../__fixtures__/v2-definition-detail.json";
import { selectAgentSessionTargets, selectLaunchSessionSettings, selectRoleChoiceTargets, selectSessionKeysFromRoleKeys,
  selectSessionSelectionsFromRoles } from "./agent-session-targets";

const definition = captured.definition;

describe("agent session choices from a pinned definition", () => {
  it("exposes each agent worker, including builder and assessor separately", () => {
    expect(selectAgentSessionTargets(definition.workflow).map((target) => [target.stage, target.worker])).toEqual([
      ["analysis", "author"], ["planning", "planner"], ["brief", "writer"],
      ["cohort", "builder"], ["cohort", "assessor"], ["integration", "integrator"],
    ]);
  });

  it("defaults integration and assessment to planner models while building uses worker models", () => {
    const targets = selectAgentSessionTargets(definition.workflow);
    expect(targets.filter((target) => target.stage === "integration" || target.stage === "cohort")
      .map((target) => [target.worker, target.suggested_role]))
      .toEqual([["builder", "worker"], ["assessor", "planner"], ["integrator", "planner"]]);
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
    const targets = selectAgentSessionTargets(definition.workflow);
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
    const result = selectLaunchSessionSettings(selectAgentSessionTargets(definition.workflow), {});
    expect(result.ok ? null : result.error.detail).toBe("Choose a runtime and model for analysis · author.");
  });

  it("offers a planner and a worker choice covering every agent session", () => {
    expect(selectRoleChoiceTargets(selectAgentSessionTargets(definition.workflow)).map((target) => [target.key, target.covers]))
      .toEqual([
        ["planner", ["analysis · author", "planning · planner", "brief · writer", "cohort · assessor", "integration · integrator"]],
        ["worker", ["cohort · builder"]],
      ]);
  });

  it("omits a role no session uses", () => {
    const targets = selectAgentSessionTargets({ workflow: "review", stages: { review: { workers: { checker: { kind: "agent" } } } } });
    expect(selectRoleChoiceTargets(targets).map((target) => target.key)).toEqual(["worker"]);
  });

  it("launches every session with its role's model when choosing by role", () => {
    const targets = selectAgentSessionTargets(definition.workflow);
    const selections = selectSessionSelectionsFromRoles(targets, {
      planner: { runtime: "claude-code", model: "opus" },
      worker: { runtime: "codex", model: "gpt-5" },
    });
    const result = selectLaunchSessionSettings(targets, selections);
    expect(result.ok && [result.value.cohort.builder.model, result.value.cohort.assessor.model, result.value.integration.integrator.model])
      .toEqual(["gpt-5", "opus", "opus"]);
  });

  it("marks a session's runtime as chosen when its role's runtime was chosen", () => {
    const targets = selectAgentSessionTargets(definition.workflow);
    expect([...selectSessionKeysFromRoleKeys(targets, new Set(["worker"]))]).toEqual([JSON.stringify(["cohort", "builder"])]);
  });
});
