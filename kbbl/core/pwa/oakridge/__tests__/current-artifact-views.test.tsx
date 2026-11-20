import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import analysis from "../__fixtures__/current-analysis.json";
import spec from "../__fixtures__/current-spec.json";
import plan from "../__fixtures__/current-plan.json";
import brief from "../__fixtures__/current-brief.json";
import unit from "../__fixtures__/resolved-assignment-unit.json";
import { CurrentSpecAnalysisViewer } from "../components/molecules/CurrentSpecAnalysisViewer";
import { CurrentSpecViewer } from "../components/molecules/CurrentSpecViewer";
import { CurrentPlanViewer } from "../components/molecules/CurrentPlanViewer";
import { CurrentBuildBriefViewer } from "../components/molecules/CurrentBuildBriefViewer";
import { ReceivedContextPanel } from "../components/molecules/ReceivedContextPanel";
import { SpecViewer } from "../components/molecules/SpecViewer";
import { parseCurrentAnalysis, parseCanonicalSpec } from "../lib/current-contract";
import { selectReceivedContext } from "../lib/received-context";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ArtifactSource } from "../artifact-types";
import type { ItemGradingSlots } from "../artifactRegistry";
import type { ObservationItemAddress } from "../grading-contracts/grading/item-reads";
import { CurrentAssessmentViewer } from "../components/molecules/CurrentAssessmentViewer";
import { compositeId } from "../adapters/core";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
const source: ArtifactSource = { run_id: "run", revision_id: "spec:1", label: null, as_of: "2026-11-17", original_spec: "Original requirements as submitted" };
const parsedAnalysis = parseCurrentAnalysis(analysis), parsedSpec = parseCanonicalSpec(spec);
if (!parsedAnalysis.ok || !parsedSpec.ok) throw new Error("fixture");
const context = { analysis: parsedAnalysis.value, spec: parsedSpec.value, requirements: parsedSpec.value.requirements };
afterEach(cleanup);
test("current analysis labels requirement statuses and finding severities", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  expect(screen.getByTestId("or-analysis-requirement-counts").textContent).toBe("Requirements1 blocked1 warning1 implementable1 not_analyzed");
  expect(screen.getByTestId("or-analysis-finding-counts").textContent).toBe("Findings2 blocking1 warning2 info");
  expect(screen.queryByText("Proposed spec updates")).toBeNull();
});
test("current analysis subnav shows requirements first, then hotspots, decisions and original input", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/ \(\d+\)$/, ""))).toEqual(["Requirements", "Code hotspots", "Operator decisions", "Original input"]);
});
test("current analysis shows one section at a time", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  fireEvent.click(screen.getByRole("tab", { name: "Original input" }));
  expect([screen.getAllByTestId("or-analysis-requirement")[0].closest("[role=tabpanel]")?.hasAttribute("hidden"), screen.getByText("Original requirements as submitted").tagName]).toEqual([true, "PRE"]);
});
test("a hotspot link returns to the requirements and brings its finding into view", () => {
  const scrolled: string[] = [];
  // jsdom does not implement scrollIntoView; record which element is asked to scroll.
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Code hotspots/ }));
  const link = screen.getAllByRole("link")[0];
  fireEvent.click(link);
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  expect([screen.getByRole("tab", { selected: true }).textContent?.startsWith("Requirements"), scrolled]).toEqual([true, [link.getAttribute("href")?.slice(1)]]);
});
test("canonical specification renders the objective, acceptance and labelled transformation links", () => {
  render(<CurrentSpecViewer body={spec} source={source} context={context} />);
  expect(screen.getByText(spec.objective)).toBeTruthy();
  for (const requirement of spec.requirements) expect(screen.getByText(requirement.acceptance_conditions[0])).toBeTruthy();
  expect(screen.getAllByText("F1")[0].closest("div")?.textContent).toContain("blocking");
});
test("canonical specification lists non-goals in their own section", () => {
  render(<CurrentSpecViewer body={spec} source={source} context={context} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Non-goals/ }));
  expect(screen.getByText("Assessment adjudication").tagName).toBe("LI");
});
test("canonical specification keeps the original input in its own section", () => {
  render(<CurrentSpecViewer body={spec} source={source} context={context} />);
  fireEvent.click(screen.getByRole("tab", { name: "Original input" }));
  expect(screen.getByText("Original requirements as submitted").tagName).toBe("PRE");
});
test("current plan shows each cohort's contributions and parallel wave", () => {
  render(<CurrentPlanViewer body={plan} context={context} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Cohorts/ }));
  expect(screen.getAllByText("Parallel wave 1")).toHaveLength(2);
  expect(screen.getByText("Parallel wave 2")).toBeTruthy();
  expect(screen.getByText("Contribution A")).toBeTruthy();
  expect(screen.getByText("Contribution B")).toBeTruthy();
  expect(screen.queryByText("Dependency order")).toBeNull();
});
test("current brief shows build items first and keeps the plan-bound envelope in its own section", () => {
  render(<CurrentBuildBriefViewer body={brief} context={context} />);
  expect(screen.getByText("Run tests")).toBeTruthy();
  expect(screen.getAllByText("D1")).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: "Envelope" }));
  expect(screen.getByTestId("or-brief-envelope").textContent).toContain("Projected from the approved plan.");
});
test("pinned assignment panel is titled What this agent received", () => {
  const received = selectReceivedContext(unit as unknown as OperatorUnitView);
  if (!received) throw new Error("assignment fixture");
  render(<ReceivedContextPanel context={received} />);
  expect(screen.getByRole("heading", { name: "What this agent received" })).toBeTruthy();
  expect(screen.queryByText("R2")).toBeNull();
});
test("legacy text specification keeps its exact display", () => {
  render(<SpecViewer body="Original legacy text" />);
  expect(screen.getByText("Original legacy text").tagName).toBe("ARTICLE");
});

/** Slots that print the item paths each viewer hands to "Show automatic grades" and to its per-item grade actions. */
const recordingGrading: ItemGradingSlots = {
  renderItemAction: (selection: ObservationItemAddress) => <span data-testid="item-action">{selection.item_path}</span>,
  renderShowAll: (selections: readonly ObservationItemAddress[]) => <span data-testid="show-all">{selections.map((selection) => selection.item_path).join(" ")}</span>,
};
const gradedSource: ArtifactSource = { ...source, revision_id: compositeId({ kind: "artifact", runId: "run", unitId: "run/analysis", name: "analysis:run/analysis:analysis:1" }) };
const gradedViewers = [
  ["analysis", () => <CurrentSpecAnalysisViewer body={analysis} source={gradedSource} itemGrading={recordingGrading} />],
  ["specification", () => <CurrentSpecViewer body={spec} source={gradedSource} context={context} itemGrading={recordingGrading} />],
  ["plan", () => <CurrentPlanViewer body={plan} source={gradedSource} context={context} itemGrading={recordingGrading} />],
  ["brief", () => <CurrentBuildBriefViewer body={brief} source={gradedSource} context={context} itemGrading={recordingGrading} />],
  ["assessment", () => <CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} source={gradedSource} itemGrading={recordingGrading} />],
] as const;
test.each(gradedViewers)("current %s offers Show automatic grades over every item it grades", (_, renderViewer) => {
  render(renderViewer());
  // Every section stays mounted, so the grade actions of all sections are present at once.
  const graded = screen.getAllByTestId("item-action").map((element) => element.textContent).sort().join(" ");
  const revealed = screen.getByTestId("show-all").textContent?.split(" ").sort().join(" ");
  expect(revealed).toBe(graded);
});
test("current plan draws the cohort dependency graph", () => {
  render(<CurrentPlanViewer body={plan} context={context} />);
  expect(screen.getAllByTestId("or-plan-graph-node")).toHaveLength(plan.cohorts.length);
});
test("selecting a cohort in the current plan graph scrolls its card into view", () => {
  const scrolled: string[] = [];
  // jsdom does not implement scrollIntoView; record which element is asked to scroll.
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  render(<CurrentPlanViewer body={plan} context={context} />);
  fireEvent.click(screen.getAllByTestId("or-plan-graph-node")[1]);
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  expect(scrolled).toEqual([`cohort-${plan.cohorts[1].id}`]);
});
test("a source reference opens the original input and brings it into view", () => {
  const scrolled: string[] = [];
  // jsdom does not implement scrollIntoView; record which element is asked to scroll.
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  fireEvent.click(screen.getAllByRole("link").find((link) => link.getAttribute("href") === "#original-input") ?? document.body);
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  expect([screen.getByRole("tab", { selected: true }).textContent, scrolled]).toEqual(["Original input", ["original-input"]]);
});
test("arrow keys move the section selection and focus, and only the selected tab is in the Tab order", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
  const selected = screen.getByRole("tab", { selected: true });
  expect([selected.textContent?.startsWith("Code hotspots"), document.activeElement === selected, screen.getAllByRole("tab").map((tab) => tab.tabIndex)]).toEqual([true, true, [-1, 0, -1, -1]]);
});
test("each section tab controls the panel that names it", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  const tab = screen.getByRole("tab", { selected: true });
  const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
  expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
});
