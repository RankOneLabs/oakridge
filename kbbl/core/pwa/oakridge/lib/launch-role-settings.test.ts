import { describe, expect, it } from "vitest";
import { makeDefinitionSummary } from "../__fixtures__/read-models";
import { selectDefinitionStages, selectRunConfig } from "./launch-role-settings";

const planner = { runtime: "claude-code" as const, model: "opus", effort: "high" };
const worker = { runtime: "codex" as const, model: "gpt-5.6-sol" };

describe("launch role settings", () => {
  it("drives the planning stages with the planner settings and every other stage with the worker settings", () => {
    expect(selectRunConfig(["analysis", "planning", "implementation"], { planner, worker })).toEqual({ sessions: {
      analysis: { harness: "claude-code", model: "opus", effort: "high" },
      planning: { harness: "claude-code", model: "opus", effort: "high" },
      implementation: { harness: "codex", model: "gpt-5.6-sol", effort: null },
    } });
  });

  it("lists each stage the definition's units run once", () => {
    expect(selectDefinitionStages(makeDefinitionSummary().bundle).length)
      .toBe(new Set(makeDefinitionSummary().bundle.units.flatMap((unit) => unit.stage ?? [])).size);
  });
});
