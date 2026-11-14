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
test("renders structured facts and navigates a stage through the route callback", () => {
  const navigate = vi.fn();
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={navigate} onBack={() => {}} />);
  expect(screen.getByRole("heading", { name: "development" })).toBeTruthy();
  expect(screen.getByText("Raw JSON").closest("details")?.open).toBe(false);
  const overview = screen.getByLabelText("Stages in authored order");
  fireEvent.click(within(overview).getAllByRole("link", { name: "cohort" })[0] as HTMLElement);
  expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/stages/cohort"));
  expect(screen.getByRole("list", { name: "Dependency edges" }).textContent).toContain("planning reads analysis.outcome.spec via input.spec");
});
test("invalid selection leaves the graph and overview visible", () => {
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "absent" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(screen.getByText("Unit absent is not in this definition.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Unit dependency graph" })).toBeTruthy();
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "absent" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(within(screen.getByTestId("or-def-selection")).getByText("Stage absent is not in this definition.")).toBeTruthy();
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
  state.data = { ...detail, workflow: { ...detail.workflow, run: { outcome: {}, units: { work: {
    for_each: "input.cohorts", key: "each.name", after: "each.depends_on", pool: "builders",
    group: { outcome: {}, units: { item } },
  } } } } };
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "work" }} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  expect(within(graph).getByRole("link", { name: "item" }).getAttribute("href")).toContain("/units/work/item");
  expect(within(graph).getByRole("link", { name: "Root" }).getAttribute("href")).toBe("#oakridge/defs/" + detail.definition_id);
  expect(within(graph).getByText(/per-member after/)).toBeTruthy();
  expect(within(graph).queryByRole("link", { name: "work (group)" })).toBeNull();
  const pane = within(screen.getByTestId("or-def-selection"));
  expect(pane.getByRole("heading", { name: "Unit: work" })).toBeTruthy();
  expect(pane.getByText(/Choose a child unit/)).toBeTruthy();
  expect(pane.getByRole("link", { name: "work/item" }).getAttribute("href")).toBe(`#oakridge/defs/${detail.definition_id}/units/work/item`);
  for (const [name, value] of [["for_each", "input.cohorts"], ["key", "each.name"], ["after", "each.depends_on"], ["pool", "builders"]]) {
    expect(pane.getByText(name as string).nextElementSibling?.textContent).toBe(value);
  }
  expect(screen.queryByRole("region", { name: "Inputs" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Workers" })).toBeNull();
});
test("schema href reveals collapsed ancestors after route navigation", () => {
  const navigate = vi.fn();
  const view = render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={navigate} onBack={() => {}} />);
  const schema = document.getElementById("definition-schema-final_merge_policy") as HTMLElement;
  expect((schema.closest("details") as HTMLDetailsElement).open).toBe(false);
  const link = screen.getByRole("link", { name: "final_merge_policy", hidden: true });
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/stages/prepare#definition-schema-final_merge_policy"));
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "prepare#definition-schema-final_merge_policy" }} onNavigate={navigate} onBack={() => {}} />);
  expect((schema.closest("details") as HTMLDetailsElement).open).toBe(true);
  expect(document.activeElement).toBe(schema);
});

test("explicit after arrays render a solid labelled edge and linked relation", () => {
  state.data = {
    ...detail,
    workflow: {
      ...detail.workflow,
      run: {
        outcome: {},
        units: {
          first: { stage: "analysis" },
          second: { stage: "planning", after: ["first"] },
        },
      },
    },
  };
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  const edge = graph.querySelector(".or-definition-edge--explicit");
  expect(edge).toBeTruthy();
  expect(edge?.querySelector("path")).toBeTruthy();
  expect(edge?.querySelector("text")?.textContent).toBe("after");
  expect(graph.querySelector(".or-definition-edge--referenced")).toBeNull();
  const relation = within(graph).getByRole("list", { name: "Dependency edges" });
  expect(relation.textContent).toBe("second after first");
  expect(within(relation).getByRole("link", { name: "second" }).getAttribute("href"))
    .toBe(`#oakridge/defs/${detail.definition_id}/units/second`);
  expect(within(relation).getByRole("link", { name: "first" }).getAttribute("href"))
    .toBe(`#oakridge/defs/${detail.definition_id}/units/first`);
});

test("array prerequisites remain visible and parallel dependency kinds stay separate", () => {
  state.data = { ...detail, workflow: { ...detail.workflow, run: { outcome: {}, units: {
    first: { stage: "analysis" },
    second: { stage: "planning", after: ["first"], input: { spec: "first.outcome.spec" } },
  } } } };
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "second" }} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("region", { name: "Definition dependencies" });
  const explicit = graph.querySelector(".or-definition-edge--explicit");
  const referenced = graph.querySelector(".or-definition-edge--referenced");
  expect(explicit?.getAttribute("transform")).toBe("translate(-6,0)");
  expect(referenced?.getAttribute("transform")).toBe("translate(6,0)");
  expect(explicit?.querySelector("text")?.textContent).toBe("after");
  expect(referenced?.querySelector("text")?.textContent).toBe("outcome.spec");
  expect(within(screen.getByRole("region", { name: "Inputs" })).getByText('["first"]')).toBeTruthy();
  expect(graph.querySelector(".or-definition-node--selected")).toBeTruthy();
  expect(within(screen.getByTestId("or-def-selection")).getByText('["first"]')).toBeTruthy();
});

test("unit routes select their stage and route changes update aria-current", () => {
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation" }} onNavigate={() => {}} onBack={() => {}} />);
  const inspector = within(screen.getByRole("region", { name: "Stage inspector" }));
  const nav = within(inspector.getByLabelText("Stages in authored order"));
  expect(nav.getByRole("link", { name: "implementation" }).getAttribute("aria-current")).toBe("page");
  expect(nav.getByRole("link", { name: "cohort" }).getAttribute("aria-current")).toBeNull();
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "integration" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(inspector.getByRole("heading", { name: "Stage: integration" })).toBeTruthy();
  expect(nav.getByRole("link", { name: "implementation" }).hasAttribute("aria-current")).toBe(false);
});
test("let expressions preserve spacing and link whole identifiers to definitions", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort" }} onNavigate={() => {}} onBack={() => {}} />);
  const completion = screen.getByRole("region", { name: "Completion" });
  const expression = completion.querySelector("p code");
  if (!(expression instanceof HTMLElement)) throw new Error("Missing completion expression");
  expect(expression.textContent).toBe(detail.effective_workflow.stages.cohort?.done_when);
  const link = within(expression).getByRole("link", { name: "pr_published" });
  expect(link.getAttribute("href")).toContain("#stage-cohort-let-pr_published");
  expect(document.getElementById("stage-cohort-let-pr_published")?.textContent).toContain("published(pr)");
});

test("whole-outcome reads appear once outside the per-field downstream lists", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort" }} onNavigate={() => {}} onBack={() => {}} />);
  const completion = within(screen.getByRole("region", { name: "Completion" }));
  expect(completion.getAllByRole("link", { name: "integration.input.cohorts" })).toHaveLength(1);
  expect(completion.getByRole("link", { name: "integration.input.cohorts" }).parentElement?.textContent).toContain("reads the whole outcome");
});

test("direct stage anchors normalize selection and reveal template details", () => {
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort#stage-cohort-template-worker-pr_watch" }} onNavigate={() => {}} onBack={() => {}} />);
  expect(within(screen.getByRole("region", { name: "Stage inspector" })).getByRole("heading", { name: "Stage: cohort" })).toBeTruthy();
  expect((document.getElementById("stage-cohort-template-worker-pr_watch") as HTMLDetailsElement).open).toBe(true);
});

test("artifact links retain anchor targets for history and reveal after route selection", () => {
  const navigate = vi.fn();
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort" }} onNavigate={navigate} onBack={() => {}} />);
  const workers = within(screen.getByRole("region", { name: "Workers" }));
  const template = workers.getByRole("link", { name: "from template pr_watch" });
  const href = template.getAttribute("href");
  fireEvent.click(template);
  expect(navigate).toHaveBeenLastCalledWith(href);
  expect(href).toContain("/stages/cohort#stage-cohort-template-worker-pr_watch");
  const details = document.getElementById("stage-cohort-template-worker-pr_watch");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing worker template");
  details.scrollIntoView = vi.fn();
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: "cohort#stage-cohort-template-worker-pr_watch" }} onNavigate={navigate} onBack={() => {}} />);
  expect(details.open).toBe(true);
  expect(details.scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(details);
  fireEvent.click(workers.getAllByRole("link", { name: "build_result" })[0] as HTMLElement);
  expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining("/stages/cohort#stage-cohort-artifact-build_result"));
});

test("following the current declaration link again reveals its target without navigating", () => {
  const navigate = vi.fn();
  const anchored = "cohort#stage-cohort-template-worker-pr_watch";
  render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "stage", stage: anchored }} onNavigate={navigate} onBack={() => {}} />);
  const template = within(screen.getByRole("region", { name: "Workers" })).getByRole("link", { name: "from template pr_watch" });
  const details = document.getElementById("stage-cohort-template-worker-pr_watch");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing worker template");
  details.open = false;
  details.scrollIntoView = vi.fn();
  window.location.hash = template.getAttribute("href") ?? "";
  fireEvent.click(template);
  expect(navigate).not.toHaveBeenCalled();
  expect(details.open).toBe(true);
  expect(details.scrollIntoView).toHaveBeenCalled();
});

test("compact header copies the full id and shared default drives every pane without navigation", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const navigate = vi.fn();
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={navigate} onBack={() => {}} />);
  expect(within(screen.getByRole("region", { name: "Workflow overview" })).getByText("6 stages · 6 units · 4 collections · 2 pools")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy definition ID" }));
  expect(writeText).toHaveBeenCalledWith(detail.definition_id);
  const first = detail.bundle.stages[0] as string;
  const nav = screen.getByLabelText("Stages in authored order");
  expect(nav.querySelector('a[aria-current="page"]')?.textContent).toBe(first);
  expect(screen.getByRole("heading", { name: "Stage: " + first })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Unit dependency graph" }).querySelector(".or-definition-node--selected")).toBeTruthy();
  fireEvent.click(screen.getByText("Raw JSON"));
  expect(screen.getByRole("tabpanel", { name: "Authored" }).textContent).toBe(JSON.stringify(detail.workflow.stages[first], null, 2));
  expect(navigate).not.toHaveBeenCalled();
});

test("unit artifact anchors keep unit identity through route changes", () => {
  const navigate = vi.fn();
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation" }} onNavigate={navigate} onBack={() => {}} />);
  const link = within(screen.getByRole("region", { name: "Workers" })).getAllByRole("link", { name: "build_result" })[0] as HTMLElement;
  fireEvent.click(link);
  expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining("/units/implementation#stage-cohort-artifact-build_result"));
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation#stage-cohort-artifact-build_result" }} onNavigate={navigate} onBack={() => {}} />);
  expect(screen.getByRole("heading", { name: "Unit: implementation" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Inputs" }).textContent).toContain("each.depends_on");
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

test("graph tooltips retain full stage names while visible labels stay compact", () => {
  const stage = "stage_name_that_exceeds_the_graph_label_limit";
  state.data = { ...detail, workflow: { ...detail.workflow, run: { outcome: {}, units: { work: { stage } } } } };
  render(<WorkflowDefDetail definitionId="d1" selection={null} onNavigate={() => {}} onBack={() => {}} />);
  const graph = screen.getByRole("img", { name: "Unit dependency graph" });
  expect(graph.querySelector("title")?.textContent).toBe(`work · ${stage}`);
  expect(within(graph).getByText(`${stage.slice(0, 27)}…`)).toBeTruthy();
});

test("Back and Forward route restoration keeps navigation, graph and detail selection aligned", () => {
  const navigate = vi.fn();
  const backSelection = { kind: "unit" as const, path: "analysis" };
  const forwardSelection = { kind: "unit" as const, path: "implementation#stage-cohort-artifact-build_result" };
  const view = render(<WorkflowDefDetail definitionId="d1" selection={backSelection} onNavigate={navigate} onBack={() => {}} />);
  fireEvent.click(within(screen.getByLabelText("Stages in authored order")).getByRole("link", { name: "implementation" }));
  expect(navigate).toHaveBeenLastCalledWith(`#oakridge/defs/${detail.definition_id}/units/implementation`);
  view.rerender(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation" }} onNavigate={navigate} onBack={() => {}} />);
  fireEvent.click(within(screen.getByRole("region", { name: "Workers" })).getAllByRole("link", { name: "build_result" })[0] as HTMLElement);
  expect(navigate).toHaveBeenLastCalledWith(`#oakridge/defs/${detail.definition_id}/units/${forwardSelection.path}`);
  // The router supplies the historical selection again on popstate, including anchors.
  for (const selection of [forwardSelection, backSelection, forwardSelection]) {
    view.rerender(<WorkflowDefDetail definitionId="d1" selection={selection} onNavigate={navigate} onBack={() => {}} />);
    const path = selection.path.split("#")[0];
    expect(screen.getByLabelText("Stages in authored order").querySelector('a[aria-current="page"]')?.textContent).toBe(path);
    expect(within(screen.getByTestId("or-def-selection")).getByRole("heading", { name: `Unit: ${path}` })).toBeTruthy();
    const selected = screen.getByRole("img", { name: "Unit dependency graph" }).querySelectorAll(".or-definition-node--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.parentElement?.querySelector("title")?.textContent?.split(" · ")[0]).toBe(path);
  }
});
