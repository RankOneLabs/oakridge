import { expect, test } from "vitest";
import type { ObservationScopedResult } from "../grading-contracts/grading/composite";
import { id, IMPLEMENTATION, item, machineAnswer, supportQuestion } from "../__fixtures__/grading";
import { selectPinnedResults } from "./pinned-results";

const pinned: ObservationScopedResult = { item: item(IMPLEMENTATION), scope: { kind: "per_item" },
  question: supportQuestion().question, evaluator: null, evidence_set_id: id("pinned"), provenance: { kind: "own", hops: [] }, status: { state: "pinned" } };
const pending: ObservationScopedResult = { ...pinned, status: { state: "pending" } };
const answered: ObservationScopedResult = { ...pinned, status: { state: "answered", answer: machineAnswer("supports") } };

test("pinned results retain their order and subject scopes", () => {
  const taskPinned: ObservationScopedResult = { ...pinned, scope: { kind: "per_task", task_id: id("task-1") } };
  expect(selectPinnedResults([pending, taskPinned, answered, pinned])).toEqual([taskPinned, pinned]);
});
test("answered and pending results are not displayed as pinned without an answer", () => {
  expect(selectPinnedResults([answered, pending])).toEqual([]);
});
