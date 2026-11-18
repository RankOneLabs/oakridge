import { render, screen, cleanup } from "@testing-library/react";
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
import { CurrentAssessmentViewer } from "../components/molecules/AssessmentViewer";
import { compositeId } from "../adapters/core";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
const source: ArtifactSource = { run_id: "run", revision_id: "spec:1", label: null, as_of: "2026-11-17", original_spec: "Original requirements as submitted" };
const parsedAnalysis = parseCurrentAnalysis(analysis), parsedSpec = parseCanonicalSpec(spec);
if (!parsedAnalysis.ok || !parsedSpec.ok) throw new Error("fixture");
const context = { analysis: parsedAnalysis.value, spec: parsedSpec.value, requirements: parsedSpec.value.requirements };
afterEach(cleanup);
test("current analysis shows requirements, separate dimensions, hotspots and operator choices", () => {
  render(<CurrentSpecAnalysisViewer body={analysis} source={source} />);
  expect(screen.getByText("1 blocked · 1 warning · 1 implementable · 1 not_analyzed")).toBeTruthy();
  expect(screen.getByText("2 blocking · 1 warning · 2 info")).toBeTruthy();
  expect(screen.getByText("Code hotspots")).toBeTruthy();
  expect(screen.getByText("Operator decisions")).toBeTruthy();
  expect(screen.queryByText("Proposed spec updates")).toBeNull();
});
test("canonical specification renders the original input, acceptance and transformation links", () => {
  render(<CurrentSpecViewer body={spec} source={source} context={context} />);
  expect(screen.getByText(spec.objective)).toBeTruthy();
  for (const requirement of spec.requirements) expect(screen.getByText(requirement.acceptance_conditions[0])).toBeTruthy();
  expect(screen.getByText("Original requirements as submitted")).toBeTruthy();
  expect(screen.getByText("Assessment adjudication")).toBeTruthy();
  expect(screen.getByText("F1 · blocking")).toBeTruthy();
});
test("current plan shows each cohort's contributions and parallel wave", () => {
  render(<CurrentPlanViewer body={plan} context={context} />);
  expect(screen.getAllByText("Parallel wave 1")).toHaveLength(2);
  expect(screen.getByText("Parallel wave 2")).toBeTruthy();
  expect(screen.getByText("Contribution A")).toBeTruthy();
  expect(screen.getByText("Contribution B")).toBeTruthy();
  expect(screen.queryByText("Dependency order")).toBeNull();
});
test("current brief separates the system-bound envelope from authored items and decisions", () => {
  render(<CurrentBuildBriefViewer body={brief} context={context} />);
  expect(screen.getByText("System-bound envelope")).toBeTruthy();
  expect(screen.getByText("Projected from the approved plan.")).toBeTruthy();
  expect(screen.getByText("oakridge")).toBeTruthy();
  expect(screen.getByText("Dependencies")).toBeTruthy();
  expect(screen.getByText("Run tests")).toBeTruthy();
  expect(screen.getAllByText("D1: Preserve readers")).toHaveLength(2);
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
  const graded = screen.getAllByTestId("item-action").map((element) => element.textContent).sort().join(" ");
  const revealed = screen.getByTestId("show-all").textContent?.split(" ").sort().join(" ");
  expect(revealed).toBe(graded);
});
test("current plan draws the cohort dependency graph", () => {
  render(<CurrentPlanViewer body={plan} context={context} />);
  expect(screen.getAllByTestId("or-plan-graph-node")).toHaveLength(plan.cohorts.length);
});
