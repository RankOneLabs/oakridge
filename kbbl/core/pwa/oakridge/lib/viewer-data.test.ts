import { expect, test } from "vitest";
import analysisBody from "../__fixtures__/current-analysis.json";
import specBody from "../__fixtures__/current-spec.json";
import planBody from "../__fixtures__/current-plan.json";
import briefBody from "../__fixtures__/current-brief.json";
import unitBody from "../__fixtures__/resolved-assignment-unit.json";
import { parseCanonicalSpec, parseCurrentAnalysis, parseCurrentPlan, parseCurrentBrief } from "./viewer-data";
import { requirementStatus, selectRequirementsByStatus, selectAnalysisCounts, selectCodeHotspots, selectOperatorDecisions, selectRequirementFindings } from "./current-analysis";
import { selectParallelWaves } from "./plan-graph";
import { selectAllocations, selectCurrentBuildItems } from "./current-brief";
import { selectReceivedContext } from "./received-context";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { definitionWithTaskSource, gradingIdentityField, selectGradingIdentityIds } from "./grading-config";
const unit = unitBody as unknown as OperatorUnitView;
const analysis = parseCurrentAnalysis(analysisBody);
const spec = parseCanonicalSpec(specBody);
const plan = parseCurrentPlan(planBody);
const brief = parseCurrentBrief(briefBody);
if (!analysis.ok || !spec.ok || !plan.ok || !brief.ok) throw new Error("invalid current fixture");
const currentAnalysis = analysis.value, currentSpec = spec.value, currentPlan = plan.value, currentBrief = brief.value;
test("current readers preserve the fixture bodies", () => {
  expect([currentAnalysis, currentSpec, currentPlan, currentBrief]).toEqual([analysisBody, specBody, planBody, briefBody]);
});
test.each([null, {}, { requirements: [{}] }])("malformed analysis yields an error value: %j", (body) => {
  expect(parseCurrentAnalysis(body).ok).toBe(false);
});
test("status derives from findings with blocking precedence and absence preserved", () => {
  expect(currentAnalysis.requirements.map(requirementStatus)).toEqual(["blocked", "warning", "implementable", "not_analyzed"]);
});
test("info does not diminish a blocking finding", () => {
  expect(requirementStatus({ ...currentAnalysis.requirements[0], findings: [currentAnalysis.requirements[0].findings[0], currentAnalysis.requirements[2].findings[0]] })).toBe("blocked");
});
test("two blocking findings are distinct from one blocked requirement", () => {
  expect(selectAnalysisCounts(currentAnalysis)).toMatchObject({ requirements: [{ status: "blocked", count: 1 }, { status: "warning", count: 1 }, { status: "implementable", count: 1 }, { status: "not_analyzed", count: 1 }], findings: [{ severity: "blocking", count: 2 }, { severity: "warning", count: 1 }, { severity: "info", count: 2 }] });
});
test("hotspots merge evidence and change locations once per finding across requirements", () => {
  expect(selectCodeHotspots(currentAnalysis).map((hotspot) => ({ path: hotspot.path, ids: hotspot.references.map((ref) => `${ref.requirement_id}/${ref.finding.id}`) }))).toEqual([{ path: "src/shared.ts", ids: ["R1/F1", "R1/F2", "R2/F3", "R2/F4", "R3/F5"] }]);
});
test("operator choices preserve undecided and explicit chosen values", () => {
  const undecided = selectOperatorDecisions(currentAnalysis)[0];
  const chosen = structuredClone(currentAnalysis);
  const resolution = chosen.requirements[2].findings[0].resolution;
  if (resolution) resolution.chosen = "Compact";
  expect([undecided.chosen, selectOperatorDecisions(chosen)[0].chosen]).toEqual(["undecided", "Compact"]);
});
test("spec references resolve nested finding records and retain unknown ids", () => {
  const requirement = { ...currentSpec.requirements[0], analysis_finding_ids: [...currentSpec.requirements[0].analysis_finding_ids, "missing" as typeof currentSpec.requirements[0]["analysis_finding_ids"][number]] };
  expect(selectRequirementFindings(requirement, currentAnalysis)).toMatchObject([{ id: "F1", reference: { requirement_id: "R1", path: "/requirements/0/findings/0", finding: { id: "F1", severity: "blocking" } } }, { id: "missing", reference: null }]);
});
test("parallel waves follow only dependency edges and preserve plan order", () => {
  const waves = selectParallelWaves(currentPlan);
  expect(waves.ok && waves.value.map((wave) => wave.map((cohort) => cohort.id))).toEqual([["A", "B"], ["C"]]);
});
test("cycles return the cohort identities as an error value", () => {
  const cycle = structuredClone(currentPlan); cycle.cohorts[0].depends_on = [cycle.cohorts[1].id]; cycle.cohorts[1].depends_on = [cycle.cohorts[0].id];
  expect(selectParallelWaves(cycle)).toMatchObject({ ok: false, error: { kind: "cycle", cohort_ids: ["A", "B", "C"] } });
});
test("unknown dependency ids return an error", () => {
  const unknown = structuredClone(currentPlan); unknown.cohorts[0].depends_on = ["missing" as typeof unknown.cohorts[0]["id"]];
  expect(selectParallelWaves(unknown)).toMatchObject({ ok: false, error: { kind: "unknown_dependency", cohort_ids: ["missing"] } });
});
test("a split requirement keeps its own contribution in each cohort", () => {
  expect(currentPlan.cohorts.slice(0, 2).flatMap((cohort) => selectAllocations(cohort, currentSpec).map((allocation) => [allocation.requirement_id, allocation.contribution, allocation.requirement?.text]))).toEqual([["R1", "Contribution A", "Render canonical requirements"], ["R1", "Contribution B", "Render canonical requirements"]]);
});
test("technical decisions appear under every build item they cite", () => {
  expect(selectCurrentBuildItems(currentBrief).map((item) => item.decisions.map((decision) => decision.id))).toEqual([["D1"], ["D1"]]);
});
test("received context contains exactly the pinned assignment requirements and revision ids", () => {
  expect(selectReceivedContext(unit)).toMatchObject({ assignment: { requirements: [{ id: "R1", acceptance_conditions: ["Visible R1"] }, { id: "R3", acceptance_conditions: ["Visible R3"] }] }, sources: [{ revision_id: "plan:1" }, { revision_id: "spec:2" }] });
});
test.each(["requirement_ids", "task_ids"] as const)("grading pointers preserve %s identity", (field) => {
  const config = { scope: "per_task", task_ids: `/${field}` };
  expect(selectGradingIdentityIds(config, { [field]: ["R1", "R3"] })).toEqual(["R1", "R3"]);
});
test("switching identity retains the generated per_task wire contract and targets requirement_ids", () => {
  const config = definitionWithTaskSource({ task_ids: "/task_ids" }, "requirement_ids");
  expect([gradingIdentityField(config), config]).toEqual(["requirement_ids", { scope: "per_task", task_ids: "/requirement_ids" }]);
});
test("analysis requirements list blocked first and keep their analysis positions", () => {
  const reversed = { ...currentAnalysis, requirements: [...currentAnalysis.requirements].reverse() };
  expect(selectRequirementsByStatus(reversed).map(({ status, index }) => [status, index])).toEqual([["blocked", 3], ["warning", 2], ["implementable", 1], ["not_analyzed", 0]]);
});
