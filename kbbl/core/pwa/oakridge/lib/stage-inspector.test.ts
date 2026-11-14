import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { stageElementHref, selectStageInspector, selectStageNavigation } from "./stage-inspector";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
test("unit selection resolves implementation to cohort", () => {
  expect(selectStageInspector(detail, { kind: "unit", path: "implementation" })?.name).toBe(
    "cohort",
  );
});
test("artifact relationships join effective workers and reviews", () => {
  expect(
    selectStageInspector(detail, { kind: "stage", stage: "cohort" })?.artifacts.find(
      (item) => item.name === "build_result",
    ),
  ).toEqual({
    name: "build_result",
    artifact: detail.effective_workflow.stages.cohort?.artifacts.build_result,
    producers: ["builder"],
    consumers: ["pr_closed"],
  });
});
test("analysis exposes both spec consumers from dependency references", () => {
  expect(
    selectStageInspector(detail, { kind: "stage", stage: "analysis" })
      ?.readers.filter((reader) => reader.outcome_path[0] === "spec")
      .map((reader) => reader.downstream)
      .sort(),
  ).toEqual(["briefs", "planning"]);
});
test("planning exposes collection reads of plan.cohorts", () => {
  expect(
    selectStageInspector(detail, { kind: "stage", stage: "planning" })?.readers,
  ).toContainEqual({
    upstream: "planning",
    downstream: "briefs",
    binding: { kind: "for_each" },
    outcome_path: ["plan", "cohorts"],
  });
});
test("unknown selections do not silently select a different stage", () => {
  expect(selectStageInspector(detail, { kind: "unit", path: "absent" })).toBeNull();
});

test("whole implementation outcomes are listed separately from named fields", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "cohort" });
  expect(model?.wholeOutcomeReaders).toContainEqual({
    upstream: "implementation",
    downstream: "integration",
    binding: { kind: "input", field: "cohorts" },
    outcome_path: [],
  });
  expect(
    model?.outcomes
      .flatMap((outcome) => outcome.readers)
      .every((reader) => reader.outcome_path.length > 0),
  ).toBe(true);
});

test("stage navigation groups invoking units in authored stage order", () => {
  expect(
    selectStageNavigation(detail).map(({ name, units }) => [name, units.map((unit) => unit.path)]),
  ).toEqual([
    ["prepare", ["prepare"]],
    ["analysis", ["analysis"]],
    ["planning", ["planning"]],
    ["brief", ["briefs"]],
    ["cohort", ["implementation"]],
    ["integration", ["integration"]],
  ]);
});

test("provenance contains each shared worker and review template only once", () => {
  const authored = detail.workflow.stages.cohort;
  const effective = detail.effective_workflow.stages.cohort;
  const worker = effective?.workers.pr_watch;
  const review = effective?.reviews?.pr_closed;
  if (!authored || !effective || !worker || !review) throw new Error("Missing cohort declarations");
  const definition: OperatorDefinitionDetail = {
    ...detail,
    workflow: {
      ...detail.workflow,
      stages: {
        ...detail.workflow.stages,
        cohort: {
          ...authored,
          workers: { ...authored.workers, another_watch: { template: "pr_watch" } },
          reviews: { ...authored.reviews, another_closed: { template: "pr_closed" } },
        },
      },
    },
    effective_workflow: {
      ...detail.effective_workflow,
      stages: {
        ...detail.effective_workflow.stages,
        cohort: {
          ...effective,
          workers: { ...effective.workers, another_watch: worker },
          reviews: { ...effective.reviews, another_closed: review },
        },
      },
    },
  };
  const model = selectStageInspector(definition, { kind: "stage", stage: "cohort" });
  expect(
    model?.sources
      .filter((source) => source.kind === "template-worker")
      .map((source) => source.name),
  ).toEqual(["pr_watch"]);
  expect(
    model?.sources
      .filter((source) => source.kind === "template-review")
      .map((source) => source.name),
  ).toEqual(["pr_closed"]);
});

test("unit model retains authored bindings and anchors keep its route", () => {
  const model = selectStageInspector(detail, { kind: "unit", path: "implementation" });
  expect(model?.selected_unit?.input).toEqual(detail.workflow.run.units.implementation?.input);
  if (!model) throw new Error("Missing implementation model");
  expect(stageElementHref(model, { kind: "artifact", name: "build_result" })).toContain("/units/implementation#stage-cohort-artifact-build_result");
});
