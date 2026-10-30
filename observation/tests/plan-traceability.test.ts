import { expect, test } from "bun:test";
import type { EvidenceSetId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { makeComparisonReport } from "../src/langfuse/comparison-report";
import { projectPilotEvidence, type EvidenceSource } from "../src/langfuse/evidence-recipe";
import { planCriterionEligibility, traceabilityExclusion } from "../src/langfuse/plan-traceability";
import { exclusionCounts, makePopulationManifest, type SelectedOccurrence } from "../src/langfuse/population-manifest";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision, type SelectedItem } from "../src/projection/extractor";

const tasksBody: JsonValue = { tasks: [{ id: "task-1", description: "Build A", requirement_ids: [] }] };
function plan(criterion: { task_ids: string[]; decision_ids: string[] }): readonly SelectedItem[] {
  const body: JsonValue = { cohorts: [{ id: "cohort-a", decisions: [{ id: "decision-a", text: "Choose A" }],
    acceptance_criteria: [{ id: "crit-a", text: "A works", ...criterion }] }] };
  return selectRevision(body, "plan-revision", oakridgeDevelopmentCatalogue("plan", "development-v1"))
    .items.map(({ item }) => item);
}
const tasks = selectRevision(tasksBody, "tasks-revision", oakridgeDevelopmentCatalogue("tasks", "development-v1"))
  .items.map(({ item }) => item);
function eligibility(criterion: { task_ids: string[]; decision_ids: string[] }, captured_tasks: readonly SelectedItem[] | null) {
  const items = plan(criterion);
  const subject = items.find((item) => item.item_kind === "criterion");
  if (!subject) throw new Error("plan has no criterion");
  const result = planCriterionEligibility(subject, { tasks: captured_tasks,
    plan_decisions: items.filter((item) => item.item_kind === "decision") });
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

test("a criterion whose citations all resolve is eligible with the cited tasks and decisions", () => {
  const result = eligibility({ task_ids: ["task-1"], decision_ids: ["decision-a"] }, tasks);
  expect(result.kind).toBe("eligible");
  if (result.kind !== "eligible") return;
  expect([...result.tasks, ...result.decisions].map((item) => item.producer_local_id)).toEqual(["task-1", "decision-a"]);
});

test("a criterion citing nothing is uncited and leaves the population", () => {
  const result = eligibility({ task_ids: [], decision_ids: [] }, tasks);
  expect(traceabilityExclusion(result)).toEqual({ kind: "uncited" });
});

test("a cited task missing from the captured revision is a dangling citation, not missing evidence", () => {
  const result = eligibility({ task_ids: ["task-1", "task-gone"], decision_ids: [] }, tasks);
  expect(traceabilityExclusion(result)).toEqual({ kind: "dangling_citation",
    evidence_refs: ["/cohorts/0/acceptance_criteria/0/task_ids/1"] });
});

test("cited tasks with no captured tasks revision are graded as incomplete evidence, not excluded", () => {
  const result = eligibility({ task_ids: ["task-1"], decision_ids: ["decision-a"] }, null);
  expect(result.kind).toBe("tasks_uncaptured");
  expect(traceabilityExclusion(result)).toBeNull();
});

test("a dangling decision is reported even when the tasks revision was not captured", () => {
  const result = eligibility({ task_ids: ["task-1"], decision_ids: ["decision-gone"] }, null);
  expect(result.kind).toBe("dangling_citation");
});

test("the traceability recipe accepts tasks alone but refuses a package with no input reference", () => {
  const question = LANGFUSE_PILOT_QUESTIONS["plan.criterion_traceability"].definition;
  const source = (role: EvidenceSource["role"]): EvidenceSource => ({ role, ref: `revision/${role}`,
    digest: `canonical-json/v1:${"a".repeat(64)}`, deep_link: `https://observation.example/items/${role}` });
  expect(projectPilotEvidence(question, [source("plan_task"), source("plan_criterion")]).ok).toBe(true);
  expect(projectPilotEvidence(question, [source("plan_criterion")]).ok).toBe(false);
});

const question_id = "plan.criterion_traceability" as QuestionId;
function member(id: string, disposition: SelectedOccurrence["disposition"], reason: SelectedOccurrence["reason"]): SelectedOccurrence {
  return { occurrence_id: id as ItemOccurrenceId, question_id, question_version: "v1", stratum: "borderline",
    disposition, reason, evidence: { evidence_set_id: `evidence-${id}` as EvidenceSetId, references: [],
      is_incomplete: false, incompleteness_reason: null } };
}
function manifest(selected: readonly SelectedOccurrence[]) {
  return makePopulationManifest({ manifest_id: "population-plan", projection_version: "v1",
    question_pins: [{ question_id, question_version: "v1" }], selected });
}

test("an uncited or dangling reason cannot mark an included member", () => {
  expect(manifest([member("occ-1", "included", { kind: "uncited" })]).ok).toBe(false);
  expect(manifest([member("occ-1", "included", { kind: "dangling_citation", evidence_refs: ["/x"] })]).ok).toBe(false);
});

test("the comparison report counts each kind of exclusion apart, outside every denominator", () => {
  const frozen = manifest([member("occ-1", "excluded", { kind: "uncited" }),
    member("occ-2", "excluded", { kind: "dangling_citation", evidence_refs: ["/cohorts/0/acceptance_criteria/0/task_ids/0"] }),
    member("occ-3", "excluded", { kind: "operator", detail: "duplicate of occ-4" }),
    member("occ-4", "included", { kind: "operator", detail: "revisioned borderline criterion" })]);
  if (!frozen.ok) throw new Error(frozen.error.detail);
  expect(exclusionCounts(frozen.value)).toEqual([{ question_id, question_version: "v1", operator: 1, uncited: 1,
    unlinked: 0, unevidenced: 0, skipped_budget: 0,
    dangling_citation: 1 }]);
  const report = makeComparisonReport(frozen.value, []);
  expect(report.ok && report.value.exclusions).toEqual(exclusionCounts(frozen.value));
});
