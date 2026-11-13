import { expect, test } from "vitest";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectDefinitionDependencies } from "./definition-dependencies";
import { selectDefinitionGraph } from "./definition-graph";
import { selectDefinitionOverview } from "./definition-overview";

const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
const workflow = {
  ...detail.workflow,
  run: {
    outcome: {},
    units: {
      start: { stage: "prepare" },
      work: {
        after: ["start"],
        group: {
          outcome: {},
          units: {
            first: { stage: "analysis" },
            nested: {
              group: {
                outcome: {},
                units: {
                  item: { stage: "cohort" },
                  finish: { stage: "integration", after: ["item"] },
                },
              },
            },
          },
        },
      },
    },
  },
};
const overview = selectDefinitionOverview({ ...detail, workflow });
const dependencies = selectDefinitionDependencies(workflow);

test("root graph keeps nested units and their edges out of the root level", () => {
  const graph = selectDefinitionGraph({ overview, dependencies, selection: null });
  expect(graph.units.map((unit) => unit.path)).toEqual(["start", "work"]);
  expect(graph.edges).toEqual([{ kind: "explicit", from: "start", to: "work", offset_x: 0 }]);
  expect(graph.breadcrumbs).toEqual([]);
});

test("nested group selection filters its level and links each ancestor breadcrumb", () => {
  const graph = selectDefinitionGraph({
    overview,
    dependencies,
    selection: { kind: "unit", path: "work/nested" },
  });
  expect(graph.units.map((unit) => unit.path)).toEqual(["work/nested/item", "work/nested/finish"]);
  expect(graph.edges).toEqual([
    { kind: "explicit", from: "work/nested/item", to: "work/nested/finish", offset_x: 0 },
  ]);
  expect(graph.breadcrumbs).toEqual([
    { name: "work", path: "work" },
    { name: "nested", path: "work/nested" },
  ]);
});

test("selecting a leaf retains its containing group level", () => {
  const group = selectDefinitionGraph({
    overview,
    dependencies,
    selection: { kind: "unit", path: "work/nested" },
  });
  const leaf = selectDefinitionGraph({
    overview,
    dependencies,
    selection: { kind: "unit", path: "work/nested/item" },
  });
  expect(leaf).toEqual(group);
});

test("stage and unknown unit selections retain the root level", () => {
  const root = selectDefinitionGraph({ overview, dependencies, selection: null });
  expect(
    selectDefinitionGraph({ overview, dependencies, selection: { kind: "stage", stage: "cohort" } }),
  ).toEqual(root);
  expect(
    selectDefinitionGraph({ overview, dependencies, selection: { kind: "unit", path: "missing" } }),
  ).toEqual(root);
});

test("development graph includes all eleven authored referenced dependencies", () => {
  const graph = selectDefinitionGraph({
    overview: selectDefinitionOverview(detail),
    dependencies: selectDefinitionDependencies(detail.workflow),
    selection: null,
  });
  expect(graph.edges.map(({ from, to, kind }) => `${from}→${to} (${kind})`).sort()).toEqual(
    [
      "prepare→analysis",
      "prepare→planning",
      "analysis→planning",
      "planning→briefs",
      "analysis→briefs",
      "prepare→briefs",
      "briefs→implementation",
      "prepare→implementation",
      "implementation→integration",
      "briefs→integration",
      "prepare→integration",
    ]
      .map((edge) => `${edge} (referenced)`)
      .sort(),
  );
});

test("parallel dependency kinds receive separate routes without changing their relationships", () => {
  const workflow = {
    ...detail.workflow,
    run: {
      outcome: {},
      units: {
        first: { stage: "analysis" },
        second: { stage: "planning", after: ["first"], input: { spec: "first.outcome.spec" } },
      },
    },
  };
  const dependencies = selectDefinitionDependencies(workflow);
  const graph = selectDefinitionGraph({
    overview: selectDefinitionOverview({ ...detail, workflow }),
    dependencies,
    selection: null,
  });
  expect(graph.edges).toEqual([
    { ...dependencies.edges[0], offset_x: -6 },
    { ...dependencies.edges[1], offset_x: 6 },
  ]);
  expect(graph.layout.edges).toHaveLength(1);
});
