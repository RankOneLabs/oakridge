import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectStageInspector } from "./stage-inspector";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
test("unit selection resolves implementation to cohort", () => {
  expect(selectStageInspector(detail, { kind: "unit", path: "implementation" })?.name).toBe("cohort");
});
test("artifact relationships join effective workers and reviews", () => {
  expect(selectStageInspector(detail, { kind: "stage", stage: "cohort" })?.artifacts.find(item => item.name === "build_result"))
    .toEqual({ name: "build_result", producers: ["builder"], consumers: ["pr_closed"] });
});
test("analysis exposes both spec consumers from dependency references", () => {
  expect(selectStageInspector(detail, { kind: "stage", stage: "analysis" })?.readers.filter(reader => reader.outcome_path[0] === "spec").map(reader => reader.downstream).sort()).toEqual(["briefs", "planning"]);
});
test("planning exposes collection reads of plan.cohorts", () => {
  expect(selectStageInspector(detail, { kind: "stage", stage: "planning" })?.readers).toContainEqual({ upstream: "planning", downstream: "briefs", binding: { kind: "for_each" }, outcome_path: ["plan", "cohorts"] });
});
test("unknown selections do not silently select a different stage", () => {
  expect(selectStageInspector(detail, { kind: "unit", path: "absent" })).toBeNull();
});
