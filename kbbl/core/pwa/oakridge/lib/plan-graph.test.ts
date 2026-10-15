import { describe, expect, test } from "vitest";
import type { CohortId } from "../types";
import type { PlanCohort } from "./plan";
import { PLAN_GRAPH_NODE, selectPlanGraphLayout } from "./plan-graph";

const cohort = (id: string, depends_on: string[] = []): PlanCohort => ({
  id: id as CohortId,
  repository_key: null,
  title: id,
  scope: "",
  depends_on: depends_on as CohortId[],
  description: null,
  files_in_scope: [],
  decisions: [],
  acceptance_criteria: [],
});

describe("selectPlanGraphLayout", () => {
  const layout = selectPlanGraphLayout([cohort("core"), cohort("api", ["core"]), cohort("ui", ["core", "api"])]);

  test("draws one edge per dependency", () => {
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["core->api", "core->ui", "api->ui"]);
  });

  test("places a dependent below what it depends on", () => {
    const top = (id: string) => layout.nodes.find((node) => node.cohort.id === id)?.y ?? Number.NaN;
    expect(top("core") < top("api") && top("api") < top("ui")).toBe(true);
  });

  test("sizes the canvas to hold every node", () => {
    const isInside = layout.nodes.every((node) => node.x >= 0 && node.y >= 0
      && node.x + PLAN_GRAPH_NODE.width <= layout.width && node.y + PLAN_GRAPH_NODE.height <= layout.height);
    expect(isInside).toBe(true);
  });

  test("ignores a dependency on a cohort the plan does not contain", () => {
    const orphan = selectPlanGraphLayout([cohort("api", ["missing"])]);
    expect([orphan.nodes.length, orphan.edges.length]).toEqual([1, 0]);
  });
});
