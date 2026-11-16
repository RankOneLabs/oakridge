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
  window.location.hash = "";
  cleanup(); state.isPending = false; state.isError = false; state.data = detail;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
state.data = detail;
import fanOut from "../../__fixtures__/definition-fan-out.json";
import reviewLoop from "../../__fixtures__/definition-review-loop.json";
import { renameStage } from "../../lib/definition-mutations.test-helpers";
import { selectDefinitionOverview, selectAbbreviatedDefinitionId } from "../../lib/definition-overview";
import { definitionTabHref, selectDefinitionStructureSummary, STAGE_TABS } from "../../lib/definition-selection";
import type { DefinitionSelection } from "../../../lib/hash";
function show(selection: DefinitionSelection | null = null) {
  return render(<WorkflowDefDetail definitionId={state.data?.definition_id ?? "d1"} selection={selection} onNavigate={() => {}} onBack={() => {}} />);
}
test("header, secondary views and raw declaration forms preserve definition access", () => {
  show({ kind: "stage", stage: "cohort", tab: null });
  expect(screen.getByRole("heading", { name: "development" })).toBeTruthy();
  expect(screen.getByText("Settings › Workflows")).toBeTruthy();
  expect(screen.getByText(`${selectAbbreviatedDefinitionId(detail.definition_id)} · ${selectDefinitionStructureSummary(selectDefinitionOverview(detail))}`)).toBeTruthy();
  for (const name of ["Schema", "Raw definition"]) {
    expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name })).toBeNull();
  }
  fireEvent.click(screen.getByRole("button", { name: "Schema" }));
  const schema = screen.getByRole("region", { name: "Schema" });
  for (const name of ["Root input", "Root outputs", "Pools"]) expect(within(schema).getByRole("heading", { name })).toBeTruthy();
  for (const entry of selectDefinitionOverview(detail).schemas) expect(document.getElementById(`definition-schema-${encodeURIComponent(entry.key)}`)?.closest('section[aria-label="Schema"]')).toBe(schema);
  fireEvent.click(screen.getByRole("button", { name: "Raw definition" }));
  expect(screen.getByRole("tabpanel", { name: "Authored" }).textContent).toContain("pr_watch");
  fireEvent.click(screen.getByRole("tab", { name: "Effective" }));
  expect(screen.getByRole("tabpanel", { name: "Effective" }).textContent).toContain("pull_request.observe");
});
test("tab changes preserve the graph node and breadcrumbs", () => {
  const view = show({ kind: "stage", stage: "cohort", tab: null });
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  expect(screen.getByTestId("or-def-split").className).toContain("lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]");
  const columns = screen.getByTestId("or-def-split").children;
  expect(columns).toHaveLength(2);
  for (const column of Array.from(columns)) expect(column.classList.contains("min-w-0")).toBe(true);
  expect(within(columns[0] as HTMLElement).getByRole("region", { name: "Definition dependencies" })).toBe(graph);
  expect(within(columns[1] as HTMLElement).getByRole("region", { name: "Stage inspector" })).toBeTruthy();
  const breadcrumbs = graph.querySelector("nav")?.outerHTML;
  expect(breadcrumbs).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Workers" })).toBeNull();
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={{ kind: "stage", stage: "cohort", tab: "workers" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Definition dependencies" })).toBe(graph);
  expect(graph.querySelector("nav")?.outerHTML).toBe(breadcrumbs);
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
  const nav = screen.getByLabelText("Stages in authored order");
  expect(Array.from(nav.querySelectorAll(".or-definition-navigation-entry > a")).map(link => link.textContent)).toEqual(definition.bundle.stages);
  for (const stage of definition.bundle.stages) {
    for (const tab of STAGE_TABS) {
      view.rerender(<WorkflowDefDetail definitionId={definition.definition_id} selection={{ kind: "stage", stage, tab: tab.value }} onNavigate={() => {}} onBack={() => {}} />);
      expect(screen.getByRole("tabpanel", { name: tab.label })).toBeTruthy();
      expect(screen.getByLabelText("Stage identity")).toBeTruthy();
      const tabs = within(screen.getByRole("tablist", { name: "Stage sections" })).getAllByRole("tab");
      expect(tabs.map(link => link.textContent)).toEqual(STAGE_TABS.map(tab => tab.label));
      expect(tabs.map(link => link.getAttribute("href"))).toEqual(STAGE_TABS.map(tab => definitionTabHref(definition.definition_id, { kind: "stage", stage, tab: null }, tab.value)));
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

test.each(["unavailable", "rejected"])("offers a selected full ID when clipboard access is %s", async (access) => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: access === "unavailable" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) } });
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy definition ID" }));
  const fullId = await screen.findByRole("textbox", { name: "Full definition ID" }) as HTMLInputElement;
  expect(fullId.value).toBe(detail.definition_id);
  expect(fullId.readOnly).toBe(true);
  expect(document.activeElement).toBe(fullId);
  expect(fullId.selectionStart).toBe(0);
  expect(fullId.selectionEnd).toBe(detail.definition_id.length);
});

test("following the current declaration link again reveals its target without navigating", () => {
  const navigate = vi.fn();
  const anchored = "cohort#stage-cohort-worker-input-pr_watch.query";
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: anchored, tab: null }} onNavigate={navigate} onBack={() => {}} />);
  const declaration = document.getElementById("stage-cohort-worker-input-pr_watch.query");
  if (!declaration) throw new Error("Missing worker input");
  const link = within(declaration).getByRole("link", { name: "inputs.query" });
  declaration.scrollIntoView = vi.fn();
  window.location.hash = link.getAttribute("href") ?? "";
  (document.activeElement as HTMLElement)?.blur();
  fireEvent.click(link);
  expect(navigate).not.toHaveBeenCalled();
  expect(declaration.scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(declaration);
});

test("let expressions preserve spacing and link whole identifiers to definitions", () => {
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort", tab: "completion" }} onNavigate={() => {}} onBack={() => {}} />);
  const completion = screen.getByRole("region", { name: "Completion" });
  const expression = completion.querySelector("p code");
  if (!(expression instanceof HTMLElement)) throw new Error("Missing completion expression");
  expect(expression.textContent).toBe(detail.effective_workflow.stages.cohort?.done_when);
  const link = within(expression).getByRole("link", { name: "pr_published" });
  expect(link.getAttribute("href")).toContain("#stage-cohort-let-pr_published");
  const navigate = vi.fn();
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort", tab: "completion" }} onNavigate={navigate} onBack={() => {}} />);
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith(link.getAttribute("href"));
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort#stage-cohort-let-pr_published", tab: null }} onNavigate={navigate} onBack={() => {}} />);
  expect(document.getElementById("stage-cohort-let-pr_published")?.textContent).toContain("published(pr)");
  expect(document.activeElement?.id).toBe("stage-cohort-let-pr_published");
});

test("array prerequisites remain visible and parallel dependency kinds stay separate", () => {
  state.data = { ...detail, workflow: { ...detail.workflow, run: { outcome: {}, units: {
    first: { stage: "analysis" },
    second: { stage: "planning", after: ["first"], input: { spec: "first.outcome.spec" } },
  } } } };
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "second", tab: "inputs" }} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  const explicit = graph.querySelector(".or-definition-edge--explicit");
  const referenced = graph.querySelector(".or-definition-edge--referenced");
  expect(explicit?.getAttribute("transform")).toBe("translate(-6,0)");
  expect(referenced?.getAttribute("transform")).toBe("translate(6,0)");
  expect(explicit?.querySelector("text")?.textContent).toBe("after");
  expect(referenced?.querySelector("text")?.textContent).toBe("outcome.spec");
  expect(within(screen.getByRole("region", { name: "Inputs" })).getByText('["first"]')).toBeTruthy();
  expect(graph.querySelector(".or-definition-node--selected")).toBeTruthy();
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "second", tab: "overview" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(within(screen.getByRole("tabpanel", { name: "Overview" })).getByText('["first"]')).toBeTruthy();
});

test("unit artifact anchors keep unit identity through route changes", () => {
  const navigate = vi.fn();
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation", tab: "workers" }} onNavigate={navigate} onBack={() => {}} />);
  const link = within(screen.getByRole("region", { name: "Workers" })).getAllByRole("link", { name: "build_result" })[0] as HTMLElement;
  fireEvent.click(link);
  expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining("/units/implementation#stage-cohort-artifact-build_result"));
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation#stage-cohort-artifact-build_result", tab: null }} onNavigate={navigate} onBack={() => {}} />);
  expect(screen.getByRole("heading", { name: "cohort · unit implementation" })).toBeTruthy();
  expect(screen.getByLabelText("Stages in authored order").querySelector('a[aria-current="page"]')?.textContent).toBe("implementation");
  expect(document.activeElement?.id).toBe("stage-cohort-artifact-build_result");

});

test("Back and Forward route restoration keeps navigation, graph and detail selection aligned", () => {
  const navigate = vi.fn();
  const backSelection = { kind: "unit" as const, path: "analysis", tab: null };
  const forwardSelection = { kind: "unit" as const, path: "implementation#stage-cohort-artifact-build_result", tab: null };
  const view = render(<WorkflowDefDetail definitionId="d1" selection={backSelection} onNavigate={navigate} onBack={() => {}} />);
  fireEvent.click(within(screen.getByLabelText("Stages in authored order")).getByRole("link", { name: "implementation" }));
  expect(navigate).toHaveBeenLastCalledWith(`#settings/workflows/${detail.definition_id}/units/implementation`);
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation", tab: "workers" }} onNavigate={navigate} onBack={() => {}} />);
  fireEvent.click(within(screen.getByRole("region", { name: "Workers" })).getAllByRole("link", { name: "build_result" })[0] as HTMLElement);
  expect(navigate).toHaveBeenLastCalledWith(`#settings/workflows/${detail.definition_id}/units/${forwardSelection.path}`);
  // The router supplies the historical selection again on popstate, including anchors.
  for (const selection of [forwardSelection, backSelection, forwardSelection]) {
    view.rerender(<WorkflowDefDetail definitionId="d1" selection={selection} onNavigate={navigate} onBack={() => {}} />);
    const path = selection.path.split("#")[0];
    expect(screen.getByLabelText("Stages in authored order").querySelector('a[aria-current="page"]')?.textContent).toBe(path);
    expect(screen.getByLabelText("Stage identity").textContent).toContain(path === "implementation" ? "cohort · unit implementation" : "analysis");
    if (selection.path.includes("#")) {
      expect(screen.getByRole("tab", { name: "Artifacts" }).getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement?.id).toBe("stage-cohort-artifact-build_result");
    }
    const selected = screen.getByRole("img", { name: "Unit dependency graph" }).querySelectorAll(".or-definition-node--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.parentElement?.querySelector("title")?.textContent?.split(" · ")[0]).toBe(path);
  }
});

test("header copies the full definition id", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Copy definition ID" }));
  expect(writeText).toHaveBeenCalledWith(detail.definition_id);
});
test("schema route opens on navigation but its toggle can close it", () => {
  window.location.hash = "#settings/workflows/stale#definition-schema-stale";
  const view = show();
  expect(screen.getByRole("button", { name: "Schema" }).getAttribute("aria-pressed")).toBe("false");
  const selection = { kind: "stage" as const, stage: "prepare#definition-schema-final_merge_policy", tab: null };
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={selection} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Schema" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Schema" }));
  expect(screen.queryByRole("region", { name: "Schema" })).toBeNull();
  expect(screen.getByRole("button", { name: "Schema" }).getAttribute("aria-pressed")).toBe("false");
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={null} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.queryByRole("region", { name: "Schema" })).toBeNull();
  view.rerender(<WorkflowDefDetail definitionId={detail.definition_id} selection={selection} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Schema" })).toBeTruthy();
  expect(document.activeElement?.id).toBe("definition-schema-final_merge_policy");
});

test("template anchors reveal enclosing details in the Prompts tab", () => {
  show({ kind: "stage", stage: "cohort#stage-cohort-template-worker-pr_watch", tab: null });
  expect(screen.getByRole("tab", { name: "Prompts" }).getAttribute("aria-selected")).toBe("true");
  const source = document.getElementById("stage-cohort-template-worker-pr_watch") as HTMLDetailsElement;
  expect(source.open).toBe(true);
  expect(document.activeElement).toBe(source);
});
