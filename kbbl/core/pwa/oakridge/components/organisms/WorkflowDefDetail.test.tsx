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
  expect(within(graph).getByText('after: ["first"]')).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Workflow overview" })).getByText('· after: ["first"]')).toBeTruthy();
  expect(within(screen.getByTestId("or-def-selection")).getByText('["first"]')).toBeTruthy();
});

test("unit routes select their stage and route changes update aria-current", () => {
  const view = render(<WorkflowDefDetail definitionId="d1" selection={{ kind: "unit", path: "implementation" }} onNavigate={() => {}} onBack={() => {}} />);
  const inspector = within(screen.getByRole("region", { name: "Stage inspector" }));
  const nav = within(inspector.getByLabelText("Stages in authored order"));
  expect(nav.getByRole("link", { name: "implementation" }).getAttribute("aria-current")).toBe("page");
  expect(nav.getByRole("link", { name: "cohort" }).getAttribute("aria-current")).toBe("page");
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
