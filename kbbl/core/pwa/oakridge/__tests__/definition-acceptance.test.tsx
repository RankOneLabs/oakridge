import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import * as artifactRegistry from "../artifactRegistry";
import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
vi.mock("../hooks/useWorkflowDef", () => ({
  useWorkflowDef: () => ({ data: detail, isPending: false, isError: false }),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function inspect(stage: string, tab: import("../lib/definition-selection").StageTab = "overview") {
  const view = render(
    <WorkflowDefDetail
      definitionId={detail.definition_id}
      selection={{ kind: "stage", stage, tab }}
      onNavigate={() => {}}
      onBack={() => {}}
    />,
  );
  expect(screen.queryByRole("region", { name: "Raw definition" })).toBeNull();
  return { ...view, inspector: within(screen.getByRole("region", { name: "Stage inspector" })) };
}
test("1: run order lists authored stages with their invoking units and per-member prerequisite", () => {
  const { inspector } = inspect("cohort");
  const nav = inspector.getByLabelText("Stages in authored order");
  expect(
    within(nav)
      .getAllByRole("option")
      .map((option) => [option.className.replace("or-definition-navigation-", ""), option.textContent?.trim()]),
  ).toEqual([
    ["stage", "prepare"],
    ["unit", "prepare"],
    ["stage", "analysis"],
    ["unit", "analysis"],
    ["stage", "planning"],
    ["unit", "planning"],
    ["stage", "brief"],
    ["unit", "briefs"],
    ["stage", "cohort"],
    ["unit", "implementation"],
    ["stage", "integration"],
    ["unit", "integration"],
  ]);
  expect(inspector.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
});
test("2: shared worker triggers expose guard, period and evaluated artifact", () => {
  const { inspector } = inspect("cohort", "workers");
  const workers = within(inspector.getByRole("region", { name: "Workers" }));
  expect(workers.getByText("from template pr_watch")).toBeTruthy();
  expect(workers.getAllByText("pr_published").length).toBeGreaterThan(0);
  expect(workers.getAllByText("every: 2m").length).toBeGreaterThan(0);
  expect(workers.getByText("evaluates:")).toBeTruthy();
  expect(workers.getAllByRole("link", { name: "build_result" }).length).toBeGreaterThan(0);
});
test("3: builder inputs and produced artifacts are inspectable links", () => {
  const { inspector } = inspect("cohort", "workers");
  const builder = within(inspector.getByRole("region", { name: "Workers" }))
    .getByRole("heading", { name: "builder" })
    .closest("article");
  if (!builder) throw new Error("Missing builder article");
  expect(within(builder).getByRole("link", { name: "inputs.brief" })).toBeTruthy();
  expect(
    within(builder).getByRole("link", { name: "build_result" }).getAttribute("href"),
  ).toContain("artifact-build_result");
  expect(within(builder).getByRole("link", { name: "pr" })).toBeTruthy();
});
test("4: plan and brief visibly flag validation and show every rule", () => {
  for (const [stage, artifact, count] of [
    ["planning", "plan", 6],
    ["brief", "brief", 4],
  ] as const) {
    const { inspector, unmount } = inspect(stage, "artifacts");
    const card = inspector
      .getByRole("heading", { name: `${artifact} · Validated artifact` })
      .closest("article");
    if (!card) throw new Error("Missing validated artifact article");
    expect(within(card).getAllByRole("listitem")).toHaveLength(count);
    unmount();
  }
});
test("5: operator approvals include effective pr_closed and integration reviews", () => {
  for (const [stage, names] of [
    ["planning", ["plan_review"]],
    ["cohort", ["assessment_review", "merge_confirmation", "pr_closed"]],
    ["integration", ["integration_review", "pr_closed"]],
  ] as const) {
    const { inspector, unmount } = inspect(stage, "reviews");
    const reviews = within(inspector.getByRole("region", { name: "Reviews" }));
    for (const name of names)
      expect(reviews.getByRole("heading", { name }).closest("article")?.textContent).toContain(
        "by: operator",
      );
    if (stage === "cohort")
      expect(
        reviews.getAllByText("Awaited-decision window · when:", { exact: false })[0],
      ).toBeTruthy();
    unmount();
  }
});
test("6: completion exposes approved(plan) with a navigable artifact", () => {
  const { inspector } = inspect("planning", "completion");
  const completion = inspector.getByRole("region", { name: "Completion" });
  expect(completion.textContent).toContain("approved(plan)");
  expect(within(completion).getAllByRole("link", { name: "plan" }).length).toBeGreaterThan(0);
});
test("7: output flow names downstream unit bindings and upstream outcomes", () => {
  const { inspector } = inspect("analysis", "completion");
  const completion = within(inspector.getByRole("region", { name: "Completion" }));
  expect(
    completion.getByRole("link", { name: "planning.input.spec" }).parentElement?.textContent,
  ).toBe("planning.input.spec reads analysis.outcome.spec");
  expect(completion.getByRole("link", { name: "briefs.input.spec" })).toBeTruthy();
});

test("prompt bodies expose pinned content and artifact links", () => {
  const {unmount} = inspect("brief", "prompts");
  const prompts = screen.getByRole("region", {name: "Prompts"});
  expect(prompts.textContent).toContain(detail.prompts["development/brief.md"].body);
  expect(prompts.textContent).toContain(detail.prompts["development/brief.md"].digest);
  expect(prompts.textContent).toContain("development/brief.md");
  unmount();
  inspect("cohort", "prompts");
  const article = document.getElementById("stage-cohort-prompt-worker%3Abuilder%3Ainitial");
  if (!article) throw new Error("Missing builder prompt");
  expect(within(article as HTMLElement).getByRole("link", {name: "build_result"}).getAttribute("href")).toContain("artifact-build_result");
  expect(within(article as HTMLElement).getByRole("link", {name: "pr"})).toBeTruthy();
});
test("definition contracts link every producing prompt and exclude run data", () => {
  const runViewer = vi.spyOn(artifactRegistry, "resolveViewer").mockReturnValue(() => <p>Run revision body sentinel</p>);
  inspect("cohort", "artifacts");
  const region = screen.getByRole("region", {name: "Artifacts"});
  expect(region.textContent).toContain("Contracts declared by this workflow definition — not artifacts produced by a run.");
  expect(within(region).getAllByRole("article").map(article => article.id)).toEqual(
    Object.keys(detail.effective_workflow.stages.cohort.artifacts).map(name => `stage-cohort-artifact-${name}`),
  );
  expect(within(region).queryByText("Run revision body sentinel")).toBeNull();
  expect(runViewer).not.toHaveBeenCalled();
  expect(within(region).queryByRole("button", {name: /revision|download/i})).toBeNull();
  const article = within(region).getByRole("heading", {name: "pr"}).closest("article");
  if (!article) throw new Error("Missing pr");
  expect(within(article).getByRole("link", {name: "worker:builder:revise"}).getAttribute("href")).toContain("prompt-worker%3Abuilder%3Arevise");
});

test("prompt and artifact cross-links open their tabs and preserve stage selection", () => {
  const onNavigate = vi.fn();
  const props = {definitionId: detail.definition_id, onNavigate, onBack: () => {}};
  const view = render(<WorkflowDefDetail {...props} selection={{kind: "stage", stage: "cohort", tab: "artifacts"}} />);
  const selectedGraphNodes = () => Array.from(
    screen.getByRole("region", {name: "Definition dependencies"}).querySelectorAll(".or-definition-node--selected"),
    node => node.parentElement?.querySelector("title")?.textContent,
  );
  const initialGraphSelection = selectedGraphNodes();
  expect(initialGraphSelection.length).toBeGreaterThan(0);
  const artifact = screen.getByRole("region", {name: "Artifacts"});
  const pr = within(artifact).getByRole("heading", {name: "pr"}).closest("article");
  if (!pr) throw new Error("Missing pr");
  fireEvent.click(within(pr).getByRole("link", {name: "worker:builder:revise"}));
  const href = onNavigate.mock.lastCall?.[0] as string;
  expect(href).toContain("/stages/cohort#stage-cohort-prompt-");
  view.rerender(<WorkflowDefDetail {...props} selection={{kind: "stage", stage: "cohort#" + href.split("#")[2], tab: null}} />);
  const row = document.getElementById("stage-cohort-prompt-worker%3Abuilder%3Arevise");
  if (!row) throw new Error("Missing prompt row");
  expect(screen.getByRole("tab", {name: "Prompts"}).getAttribute("aria-selected")).toBe("true");
  expect(selectedGraphNodes()).toEqual(initialGraphSelection);
  fireEvent.click(within(row).getByRole("link", {name: "pr"}));
  const back = onNavigate.mock.lastCall?.[0] as string;
  expect(back).toContain("/stages/cohort#stage-cohort-artifact-pr");
  view.rerender(<WorkflowDefDetail {...props} selection={{kind: "stage", stage: "cohort#" + back.split("#")[2], tab: null}} />);
  expect(screen.getByRole("tab", {name: "Artifacts"}).getAttribute("aria-selected")).toBe("true");
  expect(selectedGraphNodes()).toEqual(initialGraphSelection);
});

vi.mock("../hooks/useGradingConfiguration", () => ({ usePublishedGradingDefinitions: () => ({ definitions: [], isLoading: false, error: null }) }));
