import { expect, test } from "vitest";
import { selectGraphLayout } from "./graph-layout";

test("lays out sized nodes with top-left positions and routed edges", () => {
  const layout = selectGraphLayout({
    nodes: [
      { id: "a", width: 100, height: 50 },
      { id: "b", width: 80, height: 40 },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  expect(layout.nodes).toEqual([
    { id: "a", width: 100, height: 50, x: 4, y: 4 },
    { id: "b", width: 80, height: 40, x: 14, y: 102 },
  ]);
  expect(layout.edges).toEqual([
    { from: "a", to: "b", path: "M54,54 Q54,78 54,90 L54,102" },
  ]);
  expect([layout.width, layout.height]).toEqual([108, 146]);
});
test("drops unknown endpoints and collapses duplicate pairs", () => {
  const layout = selectGraphLayout({
    nodes: [
      { id: "a", width: 10, height: 10 },
      { id: "b", width: 10, height: 10 },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "missing", to: "a" },
      { from: "a", to: "missing" },
    ],
  });
  expect(layout.edges.map(({ from, to }) => ({ from, to }))).toEqual([
    { from: "a", to: "b" },
  ]);
  expect(layout.nodes).toHaveLength(2);
});

import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectDefinitionGraphModel } from "./definition-graph";
import { selectDefinitionGraph } from "./graph-layout";
import { selectDefinitionOverview } from "./definition-overview";
import { selectDefinitionDependencies } from "./definition-dependencies";
test("neutral root scope preserves the existing dagre unit set and edges", () => {
  const definition = snapshot.definition as unknown as OperatorDefinitionDetail;
  const input = {
    overview: selectDefinitionOverview(definition),
    dependencies: selectDefinitionDependencies(definition.workflow),
    selection: null,
  };
  expect(
    selectDefinitionGraph({
      ...input,
      model: selectDefinitionGraphModel(definition),
    }),
  ).toEqual(selectDefinitionGraph(input));
});
