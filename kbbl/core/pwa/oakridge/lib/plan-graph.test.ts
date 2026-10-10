import { describe, expect, test } from "vitest";
import { makePlanGraphFixture } from "../__fixtures__/read-models";
import { selectPlanGraph } from "./plan-graph";

const fixture = makePlanGraphFixture([
  { id: "ui", title: "UI", depends_on: ["core", "api"] },
  { id: "core", title: "Core", depends_on: [] },
  { id: "api", title: "API", depends_on: ["core"] },
], ["core", "api", "ui"]);
const layout = selectPlanGraph(fixture.body, fixture.schemas);

describe("selectPlanGraph", () => {
  test("draws one edge per dependency", () => {
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["core->api", "core->ui", "api->ui"]);
  });

  test("places a dependent after the cohorts it depends on", () => {
    const left = (id: string) => layout.nodes.find((node) => node.id === id)?.x ?? Number.NaN;
    expect(left("core") < left("api") && left("api") < left("ui")).toBe(true);
  });

  test("sizes the canvas to hold every node", () => {
    const isInside = layout.nodes.every((node) => node.x >= 0 && node.y >= 0
      && node.x + 180 <= layout.width && node.y + 70 <= layout.height);
    expect(isInside).toBe(true);
  });

  test("ignores a dependency on a cohort the plan does not contain", () => {
    const orphan = makePlanGraphFixture([{ id: "api", title: "API", depends_on: ["missing"] }]);
    const graph = selectPlanGraph(orphan.body, orphan.schemas);
    expect([graph.nodes.length, graph.edges.length]).toEqual([1, 0]);
  });

  test("uses pinned dependency order rather than source list order", () => {
    expect(layout.nodes.map((node) => node.id)).toEqual(["core", "api", "ui"]);
  });
});
