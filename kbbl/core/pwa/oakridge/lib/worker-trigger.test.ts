import { expect, test } from "vitest";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorWorker } from "../operator-contracts/core-client/core-types";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectWorkerTrigger } from "./worker-trigger";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
function cohortWorker(name: string): OperatorWorker {
  const worker = detail.effective_workflow.stages.cohort?.workers[name];
  if (!worker) throw new Error(`Missing cohort worker ${name}`);
  return worker;
}
test("pr_watch runs periodically while pr_published", () => {
  expect(selectWorkerTrigger(cohortWorker("pr_watch"))).toEqual({
    when: "pr_published",
    every: "2m",
    evaluates: null,
    modes: ["periodic"],
    handoff: null,
  });
});
test("assessor evaluates build_result with review and revision causes", () => {
  const trigger = selectWorkerTrigger(cohortWorker("assessor"));
  expect([trigger.evaluates, trigger.modes]).toEqual([
    "build_result",
    ["review_of", "changes_requested"],
  ]);
});
test("builder has missing and changes_requested causes, never handoff", () => {
  expect(selectWorkerTrigger(cohortWorker("builder")).modes).toEqual([
    "missing",
    "changes_requested",
  ]);
});

test("non-periodic code workers run when a produced artifact is missing", () => {
  expect(
    selectWorkerTrigger({
      kind: "code",
      operation: "prepare",
      produces: ["workspace"],
      inputs: {},
    }),
  ).toEqual({
    when: null,
    every: null,
    evaluates: null,
    modes: ["missing"],
    handoff: null,
  });
});
