// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PlanViewer } from "./PlanViewer";
import linkedPlan from "../../lib/__fixtures__/id-linked-plan.json";

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
  risks: [{ description: "Pin drift", mitigation: "Pin the digest." }],
};

const selectedCardId = () =>
  screen.getAllByTestId("or-plan-cohort").find((card) => card.className.includes("ring-1"))?.getAttribute("data-cohort-id");

afterEach(cleanup);

describe("PlanViewer", () => {
  test("shows decision and criterion ids with their decision links", () => {
    render(<PlanViewer body={linkedPlan} />);
    fireEvent.click(within(screen.getByTestId("or-plan-cohort")).getByRole("button", { name: /Details/ }));
    expect(within(screen.getByTestId("or-plan-cohort-details")).getByText("criterion-plan")).toBeTruthy();
    expect(screen.getAllByText("decision-layout")).toHaveLength(2);
  });

  test("shows decision and criterion text", () => {
    render(<PlanViewer body={linkedPlan} />);
    fireEvent.click(within(screen.getByTestId("or-plan-cohort")).getByRole("button", { name: /Details/ }));
    expect(screen.getByText("Keep the existing layout.")).toBeTruthy();
    expect(screen.getByText("The plan is readable.")).toBeTruthy();
  });

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

  test("shows a risk with its mitigation", () => {
    render(<PlanViewer body={body} />);
    expect(within(screen.getByTestId("or-risk-card")).getByText("Pin the digest.")).toBeTruthy();
  });

  test("each cohort lists its tasks by id, and a task two cohorts share opens the same task from both", () => {
    const onOpenTask = vi.fn();
    const task = (id: string) => ({ id, text: `Task ${id}`, decision_ids: [] });
    render(<PlanViewer onOpenTask={onOpenTask} body={{ ...body, cohorts: [{ ...cohort("api", ["core"]), acceptance_criteria: [task("T1"), task("T2")] },
      { ...cohort("core"), acceptance_criteria: [task("T1"), task("T3")] }] }} />);
    const tasksOf = (id: string) => within(screen.getAllByTestId("or-plan-cohort").find((card) => card.getAttribute("data-cohort-id") === id)!).getAllByTestId("or-plan-cohort-task");
    expect(tasksOf("api").map((chip) => chip.getAttribute("data-task-id"))).toEqual(["T1", "T2"]);
    expect(tasksOf("core").map((chip) => chip.getAttribute("data-task-id"))).toEqual(["T1", "T3"]);
    fireEvent.click(tasksOf("api")[0]!);
    fireEvent.click(tasksOf("core")[0]!);
    expect(onOpenTask.mock.calls).toEqual([["T1"], ["T1"]]);
  });

  test("without task navigation a cohort's tasks are listed but open nothing", () => {
    render(<PlanViewer body={{ ...body, cohorts: [{ ...cohort("core"), acceptance_criteria: [{ id: "T1", text: "t", decision_ids: [] }] }] }} />);
    expect(screen.getByTestId("or-plan-cohort-task").tagName).toBe("CODE");
  });

  test("refuses a bare-string risk, naming the entry", () => {
    render(<PlanViewer body={{ ...body, risks: ["Pin drift"] }} />);
    expect(screen.getByRole("alert").textContent).toContain("risks[0]: expected an object");
  });

  test("refuses a string criterion, naming the entry", () => {
    render(<PlanViewer body={{ ...body, cohorts: [{ ...cohort("core"), acceptance_criteria: ["Tests pass."] }] }} />);
    expect(screen.getByRole("alert").textContent).toContain("cohorts[0].acceptance_criteria[0]: expected a plan criterion");
  });

  test("names the broken field when the body breaks the contract", () => {
    render(<PlanViewer body={{ ...body, scope: "everything" }} />);
    expect(screen.getByRole("alert").textContent).toContain("scope: expected an object");
  });
});
