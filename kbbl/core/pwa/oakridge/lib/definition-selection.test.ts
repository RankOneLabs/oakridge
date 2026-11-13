import { expect, test } from "vitest";
import { readHashRoute, type DefinitionSelection } from "../../lib/hash";
import { definitionHref, definitionStageHref, definitionUnitHref, definitionSelectionHref, selectDefinitionSlice, definitionSchemaElementId } from "./definition-selection";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
test.each<DefinitionSelection | null>([null, { kind: "stage", stage: "review / stage" }, { kind: "unit", path: "work/item name" }])("round trips selection %j", (selection) => {
  expect(readHashRoute(definitionSelectionHref("def/1", selection), "")).toEqual({ view: "oakridge", route: { sub: "def", id: "def/1", selection } });
});
test("formats canonical routes", () => {
  expect([definitionHref("a/b"), definitionStageHref("a", "b/c"), definitionUnitHref("a", "work/item")]).toEqual(["#oakridge/defs/a%2Fb", "#oakridge/defs/a/stages/b%2Fc", "#oakridge/defs/a/units/work/item"]);
});
test("selects authored and effective stages independently", () => {
  expect(selectDefinitionSlice(detail.workflow, { kind: "stage", stage: "cohort" })).toEqual(detail.workflow.stages.cohort);
  expect(selectDefinitionSlice(detail.effective_workflow, { kind: "stage", stage: "cohort" })).toEqual(detail.effective_workflow.stages.cohort);
});
test("selects nested units and missing declarations", () => {
  const workflow = { ...detail.workflow, run: { outcome: {}, units: { work: { group: { outcome: {}, units: { item: { stage: "cohort" } } } } } } };
  expect(selectDefinitionSlice(workflow, { kind: "unit", path: "work/item" })).toEqual({ stage: "cohort" });
  expect(selectDefinitionSlice(workflow, { kind: "unit", path: "work/missing" })).toBeNull();
  expect(selectDefinitionSlice(workflow, { kind: "stage", stage: "missing" })).toBeNull();
});
test("schema targets distinguish punctuation", () => {
  expect(definitionSchemaElementId("a/b")).not.toBe(definitionSchemaElementId("a b"));
});
