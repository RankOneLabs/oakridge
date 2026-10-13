import { describe, expect, test } from "vitest";
import { makePlanGraphFixture } from "../__fixtures__/read-models";
import { selectPlanGraph } from "./plan-graph";

const cohorts = [
  { id: "api", title: "API", depends_on: ["core"] },
  { id: "core", title: "Core", depends_on: [] },
];
const ids = (order: readonly string[]) => {
  const { body } = makePlanGraphFixture(cohorts, order);
  return selectPlanGraph(body).nodes.map((node) => node.id);
};

describe("plan ordering", () => {
  test("follows dependency_order rather than body order", () => {
    expect(ids(["core", "api"])).toEqual(["core", "api"]);
  });

  test("keeps cohorts the order omits, after the ordered ones", () => {
    expect(ids(["api"])).toEqual(["api", "core"]);
  });

  test("lists a cohort once when the order repeats it", () => {
    expect(ids(["core", "core", "api"])).toEqual(["core", "api"]);
  });
});
