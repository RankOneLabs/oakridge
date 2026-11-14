import { expect, test } from "vitest";
import { correctnessQuestion, supportQuestion, id, paged } from "../__fixtures__/grading";
import type { ObservationLogicalItemId } from "../grading-contracts/domain/identity";
import { selectAssociationGradeGroups, selectSharedGradePage } from "./task-association-grades";
const taskId = id<ObservationLogicalItemId>("task");
const perItem = supportQuestion();
const perTask = correctnessQuestion({ task_id: taskId });
test("independent grades stay separated by scope and unrelated tasks are excluded", () => {
  expect(selectAssociationGradeGroups([perItem, perTask, correctnessQuestion({ task_id: id<ObservationLogicalItemId>("other") })], taskId)).toEqual([
    { scope: "per_item", questions: [perItem] }, { scope: "per_task", questions: [perTask] },
  ]);
});
test("a shared answer pager includes the longest question rather than hiding later answers", () => {
  expect(selectSharedGradePage([supportQuestion({ answers: paged([], 3, 2, 0) }), correctnessQuestion({ answers: paged([], 8, 2, 0) })], "answers")).toEqual({ total: 8, limit: 2, offset: 0 });
});
test("shared machine paging retains the requested offset even when a question is empty", () => {
  expect(selectSharedGradePage([supportQuestion({ machine: paged([], 0, 2, 0) }), correctnessQuestion({ machine: paged([], 8, 2, 2) })], "machine", { limit: 2, offset: 2 })).toEqual({ total: 8, limit: 2, offset: 2 });
});
