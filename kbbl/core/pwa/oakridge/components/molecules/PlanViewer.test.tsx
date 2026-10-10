import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { makePlanGraphFixture } from "../../__fixtures__/read-models";
import { PlanViewer } from "./PlanViewer";

const plan = makePlanGraphFixture([
  { id: "api", title: "API", depends_on: ["core"] },
  { id: "core", title: "Core", depends_on: [] },
], ["core", "api"]);

describe("PlanViewer", () => {
  test("draws every cohort in the graph", () => {
    render(<PlanViewer body={plan.body} schemas={plan.schemas} />);
    expect(screen.getAllByTestId("or-plan-graph-node")).toHaveLength(2);
  });

  test("lists cohort cards in the pinned dependency order", () => {
    render(<PlanViewer body={plan.body} schemas={plan.schemas} />);
    expect(screen.getAllByTestId("or-plan-cohort").map((card) => card.querySelector("strong")?.textContent))
      .toEqual(["core: Core", "api: API"]);
  });

  test("selects a cohort card from its graph node", () => {
    render(<PlanViewer body={plan.body} schemas={plan.schemas} />);
    fireEvent.click(screen.getAllByTestId("or-plan-graph-node")[1]!);
    expect(screen.getAllByTestId("or-plan-cohort")[1]?.getAttribute("aria-current")).toBe("true");
  });
});
