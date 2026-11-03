import { expect, test } from "bun:test";
import type { ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const OAKRIDGE_QUESTIONS = oakridgeQuestions(pilotExpectations);
import type { CapturedRevision } from "../src/grading/evidence-packages/capture";
import { PLAN_TRACEABILITY_RECIPE, unsatisfiedSlots } from "../src/grading/evidence-packages/pilot-recipe";
import { runPackages } from "../src/producers/oakridge/evidence-packages";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";

const traceability = { "plan.criterion_traceability": OAKRIDGE_QUESTIONS["plan.criterion_traceability"] };

function captured(artifact_kind: string, revision_id: string, body: JsonValue, at: string): CapturedRevision {
  const pass = selectRevision(body, revision_id, oakridgeDevelopmentCatalogue(artifact_kind, "development-v1"));
  return { ...pilotExpectations["plan.criterion_traceability"], revision_id, unit_id: artifact_kind,
    artifact_kind, recorded_at: new Date(at),
    items: pass.items.map(({ item }, index) => ({ ...item, revision_id,
      occurrence_id: `${revision_id}-${index}` as ItemOccurrenceId })) };
}

const tasksRevision = captured("tasks", "tasks-revision",
  { tasks: [{ id: "task-1", description: "Build A", requirement_ids: [] }] }, "2026-11-01T00:00:00Z");

function planRevision(criterion: { task_ids: string[]; decision_ids: string[] }): CapturedRevision {
  return captured("plan", "plan-revision", { cohorts: [{ id: "cohort-a",
    decisions: [{ id: "decision-a", text: "Choose A" }],
    acceptance_criteria: [{ id: "crit-a", text: "A works", ...criterion }] }] }, "2026-11-01T01:00:00Z");
}

function derive(criterion: { task_ids: string[]; decision_ids: string[] }, with_tasks: boolean) {
  const plan = planRevision(criterion);
  const result = runPackages(with_tasks ? [tasksRevision, plan] : [plan], traceability);
  if (!result.ok) throw new Error(result.error.detail);
  const subject = plan.items.find((item) => item.item_kind === "criterion")!;
  return { manifest: result.value,
    exclusion: result.value.exclusions.find((item) => item.occurrence_id === subject.occurrence_id)?.reason ?? null,
    pack: result.value.packages.find((item) => item.subject.occurrence_id === subject.occurrence_id) ?? null,
    decision: result.value.eligibility.find((item) => item.occurrence_id === subject.occurrence_id)?.decision ?? null };
}

test("a criterion whose citations all resolve is packaged with the cited tasks and decisions", () => {
  const { pack, decision } = derive({ task_ids: ["task-1"], decision_ids: ["decision-a"] }, true);
  expect(pack?.evidence.references.map((ref) => ref.ref)).toEqual(["plan_task:task-1", "plan_decision:decision-a", "plan_criterion:crit-a"]);
  expect(pack?.evidence.is_incomplete).toBe(false);
  expect(decision?.tag).toBe("eligible");
});

test("a criterion citing nothing is uncited and leaves the population", () => {
  const { exclusion, pack } = derive({ task_ids: [], decision_ids: [] }, true);
  expect(exclusion).toEqual({ kind: "uncited" });
  expect(pack).toBeNull();
});

test("a cited task missing from the captured revision is a dangling citation, not missing evidence", () => {
  const { exclusion, decision } = derive({ task_ids: ["task-1", "task-gone"], decision_ids: [] }, true);
  expect(exclusion).toEqual({ kind: "dangling_citation",
    evidence_refs: ["/cohorts/0/acceptance_criteria/0/task_ids/1"] });
  expect(decision?.tag).toBe("invalid_reference");
});

test("cited tasks with no captured tasks revision are graded as incomplete evidence, not excluded", () => {
  const { pack, exclusion, decision } = derive({ task_ids: ["task-1"], decision_ids: ["decision-a"] }, false);
  expect(exclusion).toBeNull();
  expect(pack?.evidence.incompleteness_reason).toBe("the run's tasks revision was not captured");
  expect(decision?.tag).toBe("eligible");
});

test("a dangling decision is reported even when the tasks revision was not captured", () => {
  const { exclusion } = derive({ task_ids: ["task-1"], decision_ids: ["decision-gone"] }, false);
  expect(exclusion).toMatchObject({ kind: "dangling_citation" });
});

test("a pin requiring more references than the capture holds is not eligible", () => {
  const demanding = { ...PLAN_TRACEABILITY_RECIPE,
    input: [{ ...PLAN_TRACEABILITY_RECIPE.input[1]!, min_count: 2, max_count: 2 }] };
  expect(unsatisfiedSlots(demanding, [{ ref: "plan_criterion:c" }, { ref: "plan_decision:d" }]))
    .toEqual(["plan_decision"]);
  expect(unsatisfiedSlots(demanding, [{ ref: "plan_criterion:c" }, { ref: "plan_decision:d" }, { ref: "plan_decision:e" }]))
    .toEqual([]);
  expect(unsatisfiedSlots(PLAN_TRACEABILITY_RECIPE, [{ ref: "plan_criterion:c" }])).toEqual([]);
});
