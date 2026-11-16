import { expect, test } from "vitest";
import { readHashRoute, type DefinitionSelection } from "../../lib/hash";
import { definitionHref, definitionStageHref, definitionUnitHref, definitionSelectionHref, selectDefinitionSlice, definitionSchemaElementId } from "./definition-selection";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
test.each<DefinitionSelection | null>([null, { kind: "stage", stage: "review / stage", tab: null }, { kind: "unit", path: "work/item name", tab: null }])("round trips selection %j", (selection) => {
  expect(readHashRoute(definitionSelectionHref("def/1", selection), "")).toEqual({ view: "settings", route: { sub: "workflow", id: "def/1", selection } });
});
test("formats canonical routes", () => {
  expect([definitionHref("a/b"), definitionStageHref("a", "b/c"), definitionUnitHref("a", "work/item")]).toEqual(["#settings/workflows/a%2Fb", "#settings/workflows/a/stages/b%2Fc", "#settings/workflows/a/units/work/item"]);
});
test("selects authored and effective stages independently", () => {
  expect(selectDefinitionSlice(detail.workflow, { kind: "stage", stage: "cohort", tab: null })).toEqual(detail.workflow.stages.cohort);
  expect(selectDefinitionSlice(detail.effective_workflow, { kind: "stage", stage: "cohort", tab: null })).toEqual(detail.effective_workflow.stages.cohort);
});
test("selects nested units and missing declarations", () => {
  const workflow = { ...detail.workflow, run: { outcome: {}, units: { work: { group: { outcome: {}, units: { item: { stage: "cohort" } } } } } } };
  expect(selectDefinitionSlice(workflow, { kind: "unit", path: "work/item", tab: null })).toEqual({ stage: "cohort" });
  expect(selectDefinitionSlice(workflow, { kind: "unit", path: "work/missing", tab: null })).toBeNull();
  expect(selectDefinitionSlice(workflow, { kind: "stage", stage: "missing", tab: null })).toBeNull();
});
test("schema targets distinguish punctuation", () => {
  expect(definitionSchemaElementId("a/b")).not.toBe(definitionSchemaElementId("a b"));
});

import { definitionTabHref, selectEffectiveStageTab, selectTabForAnchor, selectDefinitionStructureSummary } from "./definition-selection";
import { selectDefinitionOverview } from "./definition-overview";
test.each([["workers", "workers"], ["bogus", null]])("parses leading tab %s", (value, tab) => {
  expect(readHashRoute(`#settings/workflows/d1/tabs/${value}/units/work/item`, "")).toEqual({ view: "settings", route: { sub: "workflow", id: "d1", selection: { kind: "unit", path: "work/item", tab } } });
});
test("tab links preserve encoded stage names", () => {
  const href = definitionTabHref("d1", { kind: "stage", stage: "a/b", tab: null }, "reviews");
  expect(href).toBe("#settings/workflows/d1/tabs/reviews/stages/a%2Fb");
  expect(readHashRoute(href, "")).toEqual({ view: "settings", route: { sub: "workflow", id: "d1", selection: { kind: "stage", stage: "a/b", tab: "reviews" } } });
});
test.each([["let", "bindings"], ["worker", "workers"], ["worker-input", "workers"], ["template-worker", "prompts"], ["template-review", "prompts"], ["decision-set", "prompts"], ["prompt", "prompts"], ["artifact", "artifacts"], ["review", "reviews"], ["outcome", "completion"]])("maps %s anchors with hyphenated stages", (kind, tab) => {
  expect(selectTabForAnchor("a-b", `stage-a-b-${kind}-name`)).toBe(tab);
});
test("tab precedence is route, anchor, overview", () => {
  expect(selectEffectiveStageTab({ kind: "stage", stage: "a", tab: "workers" }, "stage-a-artifact-x")).toBe("workers");
  expect(selectEffectiveStageTab({ kind: "stage", stage: "a", tab: null }, "stage-a-artifact-x")).toBe("artifacts");
  expect(selectEffectiveStageTab(null, null)).toBe("overview");
  expect(selectTabForAnchor("a", "definition-schema-plan_body")).toBeNull();
});
test("structure summary derives every count", () => {
  const overview = selectDefinitionOverview(detail);
  expect(selectDefinitionStructureSummary(overview)).toBe(`${overview.stages.length} stages · ${overview.units.length} units · ${overview.groups.length} groups · ${overview.collections.length} collections · ${overview.pools.length} pools`);
});

test("unit anchor tabs use the resolved stage and respect explicit tabs", () => {
  expect(selectEffectiveStageTab({ kind: "unit", path: "work/item", tab: null }, "stage-a-b-artifact-result", "a-b")).toBe("artifacts");
  expect(selectEffectiveStageTab({ kind: "unit", path: "work/item", tab: "workers" }, "stage-a-b-artifact-result", "a-b")).toBe("workers");
});
