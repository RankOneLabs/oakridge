import { expect, test } from "bun:test";
import type { Group } from "../src/core-client/core-types";
import { selectCollectionKey, selectUnitLabel, selectUnitTree } from "../src/projections/unit-label";

/** A fan-out whose collection is declared `item`, beside a fixed unit `summary`. */
const run: Group = { outcome: {}, units: {
  work: { group: { outcome: {}, units: { item: { for_each: "input.items", key: "each.key", stage: "draft" } } } },
  summary: { stage: "draft", after: ["work"] },
} };
const units = [
  { id: "run", parent_id: null, declaration: "$root", stage: null },
  { id: "run/work", parent_id: "run", declaration: "work", stage: null },
  { id: "run/work/item", parent_id: "run/work", declaration: "item", stage: "draft" },
  { id: "run/work/b", parent_id: "run/work", declaration: "item", stage: "draft" },
  { id: "run/summary", parent_id: "run", declaration: "summary", stage: "draft" },
];
const tree = selectUnitTree(units, { workflow: "fan_out", run });

test("a collection member keyed like its declaration is still a member", () => {
  expect(units.map((unit) => [unit.id, selectCollectionKey(unit, tree)])).toEqual([
    ["run", null], ["run/work", null], ["run/work/item", "item"], ["run/work/b", "b"], ["run/summary", null],
  ]);
});

test("a member keyed like its declaration is labelled by its stage", () => {
  expect(selectUnitLabel(units[2]!, tree)).toBe("Draft");
});
