import { afterEach, expect, test, vi } from "vitest";
import { readRunRequirementComposites } from "../client-requirements";
import { definitionWithTaskSource, gradingIdentityField } from "./grading-config";
import { selectReceivedContext, selectReceivedContextView } from "./received-context";
import { selectParallelCohortRows } from "./plan-graph";
import { parseCurrentPlan } from "./viewer-data";
import unit from "../__fixtures__/resolved-assignment-unit.json";
import planBody from "../__fixtures__/current-plan.json";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
afterEach(() => vi.restoreAllMocks());
test("incomplete grading reads fail rather than presenting unread grades as missing", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [], total: 5, limit: 200, offset: 0 }));
  await expect(readRunRequirementComposites({ run_id: "run", nested: {} })).rejects.toThrow("incomplete");
});
test("switching requirement source back to task source resets its pointer", () => {
  const requirements = definitionWithTaskSource({ task_ids: "/task_ids" }, "requirement_ids");
  const tasks = definitionWithTaskSource(requirements, "task_ids");
  expect([gradingIdentityField(tasks), tasks]).toEqual(["task_ids", { scope: "per_task", task_ids: "/task_ids" }]);
});
test("handoff selector produces pinned source labels and an explicit absent label", () => {
  const context = selectReceivedContext(unit as unknown as OperatorUnitView);
  if (!context) throw new Error("fixture");
  expect(selectReceivedContextView(context).requirements.map((row) => row.source_revisions_text)).toEqual(["plan:1, spec:2", "plan:1, spec:2"]);
  expect(selectReceivedContextView({ ...context, sources: [] }).requirements[0].source_revisions_text).toBe("Not recorded");
});
test("plan selector supplies each cohort's dependency-derived wave number", () => {
  const plan = parseCurrentPlan(planBody);
  if (!plan.ok) throw new Error("fixture");
  const selected = selectParallelCohortRows(plan.value);
  expect(selected.rows.map((row) => [row.cohort.id, row.wave_number])).toEqual([["A", 1], ["B", 1], ["C", 2]]);
});

test("invalid dependency ordering keeps cohort content visible with an error value", () => {
  const plan = parseCurrentPlan({ ...planBody, cohorts: planBody.cohorts.map((cohort) => ({ ...cohort, depends_on: ["missing"] })) });
  if (!plan.ok) throw new Error("fixture");
  const selected = selectParallelCohortRows(plan.value);
  expect([selected.error?.kind, selected.rows.map((row) => row.wave_number)]).toEqual(["unknown_dependency", [null, null, null]]);
});
