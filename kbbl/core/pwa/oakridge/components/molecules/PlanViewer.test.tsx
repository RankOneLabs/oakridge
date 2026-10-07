// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PlanViewer } from "./PlanViewer";

const cohort = (id: string, depends_on: string[] = []) => ({
  id,
  repository_key: "oakridge",
  title: `Title of ${id}`,
  scope: "One package.",
  depends_on,
  description: `Description of ${id}`,
  files_in_scope: [`src/${id}.ts`],
  decisions: [],
  acceptance_criteria: [],
});

const body = {
  summary: "Two cohorts.",
  cohorts: [cohort("api", ["core"]), cohort("core")],
  dependency_order: ["core", "api"],
  scope: { in_scope: ["The API"], out_of_scope: ["The UI"] },
  acceptance_criteria: ["Ships."],
  risks: ["Pin drift"],
};

const selectedCardId = () =>
  screen.getAllByTestId("or-plan-cohort").find((card) => card.className.includes("ring-1"))?.getAttribute("data-cohort-id");

afterEach(cleanup);

describe("PlanViewer", () => {
  test("draws every cohort in the graph", () => {
    render(<PlanViewer body={body} />);
    expect(screen.getAllByTestId("or-plan-graph-node")).toHaveLength(2);
  });

  test("lists cohort cards in dependency order", () => {
    render(<PlanViewer body={body} />);
    expect(screen.getAllByTestId("or-plan-cohort").map((card) => card.getAttribute("data-cohort-id"))).toEqual(["core", "api"]);
  });

  test("selects a cohort's card from its graph node", () => {
    render(<PlanViewer body={body} />);
    fireEvent.click(within(screen.getByTestId("or-plan-graph")).getByTitle("Title of api"));
    expect(selectedCardId()).toBe("api");
  });

  test("selects a dependency from a card's After chip", () => {
    render(<PlanViewer body={body} />);
    fireEvent.click(screen.getByRole("button", { name: "core" }));
    expect(selectedCardId()).toBe("core");
  });

  test("keeps cohort details folded until asked", () => {
    render(<PlanViewer body={body} />);
    const card = screen.getAllByTestId("or-plan-cohort")[0]!;
    fireEvent.click(within(card).getByRole("button", { name: /Details/ }));
    expect(within(card).getByText("src/core.ts")).toBeTruthy();
  });

  test("shows a bare-string risk without a mitigation", () => {
    render(<PlanViewer body={body} />);
    expect(within(screen.getByTestId("or-risk-card")).getByText("No mitigation given.")).toBeTruthy();
  });

  test("names the broken field when the body breaks the contract", () => {
    render(<PlanViewer body={{ ...body, scope: "everything" }} />);
    expect(screen.getByRole("alert").textContent).toContain("scope: expected an object");
  });
});
