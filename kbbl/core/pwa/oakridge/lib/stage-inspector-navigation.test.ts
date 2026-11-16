import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import fanOut from "../__fixtures__/definition-fan-out.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { definitionStageHref, definitionUnitHref } from "./definition-selection";
import { selectStageInspector } from "./stage-inspector";
import { selectStageInspectorIdentity, selectStageInspectorNavigation } from "./stage-inspector-navigation";

const detail = fixture.definition as unknown as OperatorDefinitionDetail;

test("navigation preserves authored order and merges only identical sole-unit labels", () => {
  const navigation = selectStageInspectorNavigation(detail, null);
  expect(navigation.stages.map(entry => entry.stage.label)).toEqual(detail.bundle.stages);
  expect(navigation.stages.find(entry => entry.stage.label === "prepare")).toEqual({
    stage: { label: "prepare", href: definitionStageHref(detail.definition_id, "prepare"), isCurrent: false },
    units: [], isSelected: false,
  });
  expect(navigation.stages.find(entry => entry.stage.label === "brief")?.units).toEqual([
    { label: "briefs", href: definitionUnitHref(detail.definition_id, "briefs"), isCurrent: false },
  ]);
});

test("a merged unit selection marks its stage link current", () => {
  const navigation = selectStageInspectorNavigation(detail, { kind: "unit", path: "prepare", tab: null });
  expect(navigation.stages.filter(entry => entry.stage.isCurrent).map(entry => entry.stage.label)).toEqual(["prepare"]);
  expect(navigation.stages.find(entry => entry.stage.label === "prepare")?.isSelected).toBe(true);
});

test("a distinct unit marks only its unit link current and highlights its stage", () => {
  const navigation = selectStageInspectorNavigation(detail, { kind: "unit", path: "implementation", tab: "artifacts" });
  const stage = navigation.stages.find(entry => entry.stage.label === "cohort");
  expect(stage?.isSelected).toBe(true);
  expect(stage?.stage.isCurrent).toBe(false);
  expect(stage?.units.filter(unit => unit.isCurrent).map(unit => unit.label)).toEqual(["implementation"]);
});

test("stage selection marks its stage current without marking invoking units", () => {
  const navigation = selectStageInspectorNavigation(detail, { kind: "stage", stage: "cohort", tab: null });
  expect(navigation.stages.filter(entry => entry.stage.isCurrent).map(entry => entry.stage.label)).toEqual(["cohort"]);
  expect(navigation.stages.flatMap(entry => entry.units).some(unit => unit.isCurrent)).toBe(false);
});

test("matching labels remain separate when a stage has multiple invokers", () => {
  const definition = { ...detail, workflow: { ...detail.workflow, run: {
    ...detail.workflow.run, units: { prepare: { stage: "prepare" }, other: { stage: "prepare" } },
  } } };
  const selection = { kind: "unit" as const, path: "prepare", tab: null };
  const stage = selectStageInspectorNavigation(definition, selection).stages.find(entry => entry.stage.label === "prepare");
  expect(stage?.units.map(unit => unit.label)).toEqual(["prepare", "other"]);
  expect(stage?.stage.isCurrent).toBe(false);
  const identity = selectStageInspectorIdentity(selectStageInspector(definition, selection));
  expect(identity?.invokers.map(unit => unit.label)).toEqual(["prepare", "other"]);
});

test("identity merges identical labels and retains distinct selected unit names and invokers", () => {
  expect(selectStageInspectorIdentity(selectStageInspector(detail, { kind: "unit", path: "prepare", tab: null }))).toEqual({ title: "prepare", invokers: [] });
  expect(selectStageInspectorIdentity(selectStageInspector(detail, { kind: "unit", path: "implementation", tab: null }))).toEqual({
    title: "cohort · unit implementation",
    invokers: [{ label: "implementation", href: definitionUnitHref(detail.definition_id, "implementation"), isCurrent: true }],
  });
  expect(selectStageInspectorIdentity(selectStageInspector(detail, { kind: "stage", stage: "cohort", tab: null }))?.title).toBe("cohort");
  expect(selectStageInspectorIdentity(null)).toBeNull();
});

test("nested group links retain their routes and current selection", () => {
  const definition = fanOut.definition as unknown as OperatorDefinitionDetail;
  const navigation = selectStageInspectorNavigation(definition, { kind: "unit", path: "work", tab: null });
  expect(navigation.groups).toEqual([
    { label: "work (group)", href: definitionUnitHref(definition.definition_id, "work"), isCurrent: true },
  ]);
  expect(navigation.stages.some(stage => stage.isSelected)).toBe(false);
});
