import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { OAKRIDGE_QUESTIONS } from "../src/grading/catalogue/oakridge-questions";
import { projectPilotEvidence, type EvidenceSource } from "../src/grading/evidence-packages/pilot-recipe";
import { planCriterionEligibility, traceabilityExclusion } from "../src/producers/oakridge/plan-traceability";
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
  const question = OAKRIDGE_QUESTIONS["plan.criterion_traceability"].definition;
  const source = (role: EvidenceSource["role"]): EvidenceSource => ({ role, ref: `revision/${role}`,
    digest: `canonical-json/v1:${"a".repeat(64)}`, deep_link: `https://observation.example/items/${role}` });
  expect(projectPilotEvidence(question, [source("plan_task"), source("plan_criterion")]).ok).toBe(true);
  expect(projectPilotEvidence(question, [source("plan_criterion")]).ok).toBe(false);
});
