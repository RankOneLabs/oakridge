import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { OperatorAuthoredWorkflow } from "../operator-contracts/core-client/core-types";
import { selectDefinitionDependencies } from "./definition-dependencies";

const root = resolve(import.meta.dirname, "../../../../../workflow-config/definitions");
const catalog = JSON.parse(readFileSync(resolve(root, "launchable.json"), "utf8")) as { [name: string]: string };
function source(name: string): OperatorAuthoredWorkflow {
  return (JSON.parse(readFileSync(resolve(root, "workflows", `${catalog[name]}.json`), "utf8")) as { source: OperatorAuthoredWorkflow }).source;
}
test("development references retain bindings and outcome paths", () => {
  const result = selectDefinitionDependencies(source("development"));
  expect(result.edges.filter((edge) => edge.kind === "explicit")).toEqual([]);
  expect(result.edges.map((edge) => `${edge.from}->${edge.to}`).sort()).toEqual([
    "prepare->analysis", "prepare->planning", "analysis->planning", "planning->briefs", "analysis->briefs", "prepare->briefs",
    "briefs->implementation", "prepare->implementation", "implementation->integration", "briefs->integration", "prepare->integration",
  ].sort());
  expect(result.references).toHaveLength(13);
  expect(result.references).toContainEqual({ downstream: "planning", binding: { kind: "input", field: "spec" }, upstream: "analysis", outcome_path: ["spec"] });
  expect(result.per_member_after).toEqual([{ unit: "implementation", expression: "each.depends_on" }]);
});
test("fan-out recurses with declaration paths and preserves per-member after", () => {
  const result = selectDefinitionDependencies(source("fan-out"));
  expect(result.edges).toMatchObject([{ kind: "referenced", from: "prepare", to: "work" }]);
  expect(result.per_member_after).toEqual([{ unit: "work/item", expression: "each.after" }]);
});
test("review-loop has no sibling dependencies", () => {
  expect(selectDefinitionDependencies(source("review-loop"))).toEqual({ references: [], edges: [], per_member_after: [] });
});
test("explicit and referenced dependencies coexist, ignoring other identifiers and quoted strings", () => {
  const workflow = source("review-loop");
  const result = selectDefinitionDependencies({ ...workflow, run: { outcome: {}, units: {
    a: {}, b: { after: ["a"], input: { value: 'map(a, a.outcome.value) + a.outcome.value + input.a.outcome + "a.outcome.fake" + other.outcome' } },
  } } });
  expect(result.edges.map((edge) => edge.kind)).toEqual(["explicit", "referenced"]);
  expect(result.references).toEqual([{ downstream: "b", binding: { kind: "input", field: "value" }, upstream: "a", outcome_path: ["value"] }]);
});
test("bare map and contains references and key expressions retain their bindings", () => {
  const result = selectDefinitionDependencies({ ...source("review-loop"), run: { outcome: {}, units: {
    a: {}, b: { for_each: "map(a, item)", key: "contains(a, key)", input: { value: "a.outcome" } },
  } } });
  expect(result.references.map(({ binding, outcome_path }) => ({ binding, outcome_path }))).toEqual([
    { binding: { kind: "input", field: "value" }, outcome_path: [] },
    { binding: { kind: "for_each" }, outcome_path: [] }, { binding: { kind: "key" }, outcome_path: [] },
  ]);
});

test.each(["a . outcome.value", "a. outcome . value", "a\n.\toutcome . value", "map ( a , a . outcome . value )"])(
  "whitespace preserves sibling outcome references in %s", (expression) => {
    const result = selectDefinitionDependencies({ ...source("review-loop"), run: { outcome: {}, units: {
      a: {}, b: { input: { value: expression } },
    } } });
    expect(result.references).toEqual([{ downstream: "b", binding: { kind: "input", field: "value" }, upstream: "a", outcome_path: ["value"] }]);
  },
);

test.each(["input . a.outcome.value", "input\n.\ta . outcome . value", "input . map(a, item)", "input . contains(a, key)"])(
  "whitespace in field access creates no sibling edges in %s", (expression) => {
    const result = selectDefinitionDependencies({ ...source("review-loop"), run: { outcome: {}, units: {
      a: {}, b: { input: { value: expression } },
    } } });
    expect(result).toEqual({ references: [], edges: [], per_member_after: [] });
  },
);

test.each([
  ["build-step.outcome.result", "build-step", ["result"]],
  ["$prep.outcome.result", "$prep", ["result"]],
  ["(a).outcome.result", "a", ["result"]],
  ["(a.outcome).result", "a", ["result"]],
  ["not (a.outcome.result)", "a", ["result"]],
  ["map((a), a.outcome.result)", "a", ["result"]],
])("compiler identifiers and grouping preserve the reference in %s", (expression, upstream, outcome_path) => {
  const result = selectDefinitionDependencies({ ...source("review-loop"), run: { outcome: {}, units: {
    a: {}, "build-step": {}, $prep: {}, step: {}, b: { input: { value: expression } },
  } } });
  expect(result.references).toEqual([{ downstream: "b", binding: { kind: "input", field: "value" }, upstream, outcome_path }]);
});
