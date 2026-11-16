import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import snapshot from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { WorkflowDefDetail } from "./WorkflowDefDetail";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const state = vi.hoisted(() => ({ isPending: false, isError: false, data: null as OperatorDefinitionDetail | null, error: null }));
vi.mock("../../hooks/useWorkflowDef", () => ({ useWorkflowDef: () => state }));
afterEach(() => {
  cleanup(); state.isPending = false; state.isError = false; state.data = detail;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
state.data = detail;
import fanOut from "../../__fixtures__/definition-fan-out.json";
import reviewLoop from "../../__fixtures__/definition-review-loop.json";
import { renameStage } from "../../lib/definition-mutations.test-helpers";
import { STAGE_TABS } from "../../lib/definition-selection";
import type { DefinitionSelection } from "../../../lib/hash";
function show(selection: DefinitionSelection | null = null) {
  return render(<WorkflowDefDetail definitionId={state.data?.definition_id ?? "d1"} selection={selection} onNavigate={() => {}} onBack={() => {}} />);
}
test("header, secondary views and raw declaration forms preserve definition access", () => {
  show({ kind: "stage", stage: "cohort", tab: null });
  expect(screen.getByRole("heading", { name: "development" })).toBeTruthy();
  expect(screen.getByText("Settings › Workflows")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Schema" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Schema" }));
  expect(screen.getByRole("region", { name: "Schema" }).textContent).toContain("Root outputs");
  fireEvent.click(screen.getByRole("button", { name: "Raw definition" }));
  expect(screen.getByRole("tabpanel", { name: "Authored" }).textContent).toContain("pr_watch");
  fireEvent.click(screen.getByRole("tab", { name: "Effective" }));
  expect(screen.getByRole("tabpanel", { name: "Effective" }).textContent).toContain("pull_request.observe");
});
test("tab changes preserve the graph node and breadcrumbs", () => {
  const view = show({ kind: "stage", stage: "cohort", tab: null });
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  expect(screen.getByTestId("or-def-split").className).toContain("lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]");
  expect(screen.queryByRole("region", { name: "Workers" })).toBeNull();
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={{ kind: "stage", stage: "cohort", tab: "workers" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Definition dependencies" })).toBe(graph);
  expect(screen.getByRole("region", { name: "Workers" })).toBeTruthy();
});
test("artifact anchor activates its tab and focuses the declaration", () => {
  show({ kind: "unit", path: "implementation#stage-cohort-artifact-build_result", tab: null });
  expect(screen.getByRole("tab", { name: "Artifacts" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement?.id).toBe("stage-cohort-artifact-build_result");
});
test("loading and errors retain their surfaces", () => {
  state.isPending = true;
  const view = show();
  expect(screen.getByTestId("or-def-detail-loading")).toBeTruthy();
  state.isPending = false; state.isError = true;
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByTestId("or-def-detail-error")).toBeTruthy();
});
const fan = fanOut.definition as unknown as OperatorDefinitionDetail;
test.each([detail, fan, reviewLoop.definition as unknown as OperatorDefinitionDetail, renameStage(fan, { old: fan.bundle.stages[0] ?? "", name: "renamed" })])("same UI renders every stage and tab of $workflow.workflow", definition => {
  state.data = definition;
  const view = show();
  expect(screen.getByRole("heading", { name: definition.effective_workflow.workflow })).toBeTruthy();
  for (const stage of definition.bundle.stages) {
    for (const tab of STAGE_TABS) {
      view.rerender(<WorkflowDefDetail definitionId={definition.definition_id} selection={{ kind: "stage", stage, tab: tab.value }} onNavigate={() => {}} onBack={() => {}} />);
      expect(screen.getByRole("tabpanel", { name: tab.label })).toBeTruthy();
      expect(screen.getByLabelText("Stage identity")).toBeTruthy();
      expect(screen.getByRole("tablist", { name: "Stage sections" }).children).toHaveLength(8);
      expect(within(screen.getByLabelText("Stages in authored order")).getByRole("link", { name: stage })).toBeTruthy();
    }
  }
}, 30000);

test("review-loop decisions and fan-out unit facts come from their definitions", () => {
  const review = reviewLoop.definition as unknown as OperatorDefinitionDetail;
  state.data = review;
  const view = show({ kind: "stage", stage: "document", tab: "reviews" });
  const section = screen.getByRole("region", { name: "Reviews" });
  for (const [name, declaration] of Object.entries(review.effective_workflow.stages.document?.reviews ?? {})) {
    expect(section.textContent).toContain(name);
    for (const decision of Object.keys(declaration.decisions)) expect(section.textContent).toContain(decision);
  }
  state.data = fan;
  view.rerender(<WorkflowDefDetail definitionId={fan.definition_id} selection={{ kind: "unit", path: "work/item", tab: "overview" }} onNavigate={() => {}} onBack={() => {}} />);
  const facts = screen.getByRole("tabpanel", { name: "Overview" });
  const unit = fan.workflow.run.units.work?.group?.units.item;
  for (const value of [unit?.for_each, unit?.key, unit?.pool]) if (value) expect(facts.textContent).toContain(value);
});
test("schema anchor opens the secondary view and missing stages preserve the graph", () => {
  const view = show({ kind: "stage", stage: "prepare#definition-schema-final_merge_policy", tab: null });
  expect(screen.getByRole("region", { name: "Schema" })).toBeTruthy();
  expect(document.activeElement?.id).toBe("definition-schema-final_merge_policy");
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={{ kind: "stage", stage: "absent", tab: null }} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByText("Stage absent is not in this definition.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Definition dependencies" })).toBeTruthy();
});

test("empty selection, back action and graph navigation update the inspector without scrolling", () => {
  const onBack = vi.fn();
  const onNavigate = vi.fn();
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const view = render(<WorkflowDefDetail definitionId={detail.definition_id} selection={null} onNavigate={onNavigate} onBack={onBack} />);
    expect(screen.getByText("Select a stage or unit to inspect its declaration.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Workflows" }));
    expect(onBack).toHaveBeenCalledOnce();
    const graph = screen.getByRole("region", { name: "Definition dependencies" });
    fireEvent.click(within(graph).getAllByRole("link", { name: "implementation" })[0] as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith(expect.stringContaining("/units/implementation"));
    view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={{ kind: "unit", path: "implementation", tab: null }} onNavigate={onNavigate} onBack={onBack} />);
    expect(screen.getByRole("heading", { name: "cohort · unit implementation" })).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
  } finally { Element.prototype.scrollIntoView = original; }
});
test("renamed stages replace navigation and tab destinations", () => {
  const old = fan.bundle.stages[0] ?? "";
  state.data = renameStage(fan, { old, name: "renamed_stage" });
  show({ kind: "stage", stage: "renamed_stage", tab: null });
  const nav = screen.getByLabelText("Stages in authored order");
  expect(within(nav).getByRole("link", { name: "renamed_stage" })).toBeTruthy();
  for (const link of Array.from(document.querySelectorAll('a[href*="/stages/"]'))) {
    expect(link.getAttribute("href")).not.toContain("/stages/" + old);
  }
});
