import { describe, expect, it } from "vitest";
import captured from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts";
import { selectAgentSessionTargets, selectLaunchSessionSettings } from "./agent-session-targets";

const definition = captured.definition as unknown as OperatorDefinitionDetail;

describe("agent session choices from a pinned definition", () => {
  it("exposes each agent worker, including builder and assessor separately", () => {
    expect(selectAgentSessionTargets(definition.workflow).map((target) => target.key)).toEqual([
      "analysis.author", "planning.planner", "brief.writer", "cohort.builder", "cohort.assessor", "integration.integrator",
    ]);
  });

  it("creates independent settings for each agent worker", () => {
    const targets = selectAgentSessionTargets(definition.workflow);
    const selections = Object.fromEntries(targets.map((target) => [target.key,
      { runtime: "claude-code" as const, model: target.worker === "assessor" ? "opus" : "sonnet" }]));
    const result = selectLaunchSessionSettings(targets, selections);
    expect(result.ok && [result.value["cohort.assessor"], result.value["cohort.builder"]]).toEqual([
      { harness: "claude-code", model: "opus", effort: null },
      { harness: "claude-code", model: "sonnet", effort: null },
    ]);
  });

  it("rejects an incomplete choice before launch", () => {
    const result = selectLaunchSessionSettings(selectAgentSessionTargets(definition.workflow), {});
    expect(result.ok ? null : result.error.detail).toBe("Choose a runtime and model for analysis · author.");
  });
});
