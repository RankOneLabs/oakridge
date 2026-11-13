import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectWorkerTrigger } from "./worker-trigger";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
const workers = detail.effective_workflow.stages.cohort!.workers;
test("pr_watch runs periodically while pr_published", () => {
  expect(selectWorkerTrigger(workers.pr_watch!)).toEqual({
    when: "pr_published",
    every: "2m",
    evaluates: null,
    modes: ["periodic"],
    handoff: null,
  });
});
test("assessor evaluates build_result with review and revision causes", () => {
  const trigger = selectWorkerTrigger(workers.assessor!);
  expect([trigger.evaluates, trigger.modes]).toEqual([
    "build_result",
    ["review_of", "changes_requested"],
  ]);
});
test("builder has missing and changes_requested causes, never handoff", () => {
  expect(selectWorkerTrigger(workers.builder!).modes).toEqual(["missing", "changes_requested"]);
});
