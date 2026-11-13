import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import snapshot from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { WorkflowDefDetail } from "./WorkflowDefDetail";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
const state = vi.hoisted(() => ({ isPending: false, isError: false, data: null as OperatorDefinitionDetail | null, error: null }));
vi.mock("../../hooks/useWorkflowDef", () => ({ useWorkflowDef: () => state }));
afterEach(() => { cleanup(); state.isPending = false; state.isError = false; state.data = detail; });
state.data = detail;
test("renders structured facts and navigates a stage through the route callback", () => {
  const navigate = vi.fn();
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={navigate} onBack={() => {}} />);
  expect(screen.getByRole("heading", { name: "development" })).toBeTruthy();
  expect(screen.getByText("Raw JSON").closest("details")?.open).toBe(false);
  const overview = screen.getByRole("region", { name: "Workflow overview" });
  fireEvent.click(within(overview).getAllByRole("link", { name: "cohort" })[0] as HTMLElement);
  expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/stages/cohort"));
  expect(screen.getByRole("list", { name: "Dependency edges" }).textContent).toContain("planning reads analysis.outcome.spec via input.spec");
});
test("invalid selection leaves the graph and overview visible", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "absent" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByText("Unit absent is not in this definition.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Unit dependency graph" })).toBeTruthy();
});
test("raw selection begins authored and switches to effective", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort" }} onNavigate={() => {}} onBack={() => {}} />);
  fireEvent.click(screen.getByText("Raw JSON"));
  expect(screen.getByRole("tabpanel", { name: "Authored" }).textContent).toContain("pr_watch");
  fireEvent.click(screen.getByRole("tab", { name: "Effective" }));
  expect(screen.getByRole("tabpanel", { name: "Effective" }).textContent).toContain("pull_request.observe");
});
test("preserves loading and error surfaces", () => {
  state.isPending = true;
  const view = render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByTestId("or-def-detail-loading")).toBeTruthy();
  state.isPending = false; state.isError = true;
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByTestId("or-def-detail-error")).toBeTruthy();
});
test("group selection drills in and exposes a root breadcrumb", () => {
  const item = { stage: "cohort", for_each: "input.items", after: "each.after" };
  state.data = { ...detail, workflow: { ...detail.workflow, run: { outcome: {}, units: { work: { group: { outcome: {}, units: { item } } } } } } };
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "work" }} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  expect(within(graph).getByRole("link", { name: "item" }).getAttribute("href")).toContain("/units/work/item");
  expect(within(graph).getByRole("link", { name: "Root" }).getAttribute("href")).toBe("#oakridge/defs/" + detail.definition_id);
  expect(within(graph).getByText("after: each.after")).toBeTruthy();
  expect(within(graph).queryByRole("link", { name: "work (group)" })).toBeNull();
});
test("schema references focus the overview entry without changing the route", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  const schema = screen.getByRole("heading", { name: "final_merge_policy" }).parentElement as HTMLElement;
  schema.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "final_merge_policy" }));
  expect(document.activeElement).toBe(schema);
});
