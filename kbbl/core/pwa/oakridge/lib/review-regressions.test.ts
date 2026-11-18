import { afterEach, expect, test, vi } from "vitest";
import { readRunRequirementComposites } from "../client-requirements";
import { selectRequirementGradingRows } from "./grading-identity";
import { definitionWithTaskSource, gradingIdentityField } from "./grading-config";
import { selectReceivedContext, selectReceivedContextView } from "./received-context";
import { selectParallelCohortRows } from "./plan-graph";
import { parseCurrentPlan } from "./current-contract";
import { taskComposite } from "../__fixtures__/grading";
import unit from "../__fixtures__/resolved-assignment-unit.json";
import planBody from "../__fixtures__/current-plan.json";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
afterEach(() => vi.restoreAllMocks());
test("requirements across grading pages keep their grade when canonical rows change pages", async () => {
  const rows = Array.from({ length: 75 }, (_, index) => ({ id: `R${index + 1}`, description: `Requirement ${index + 1}`, requirement_ids: [] }));
  const composites = rows.map((row) => taskComposite(row.id)).reverse();
  const offsets: number[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const offset = Number(new URL(String(input), "http://test").searchParams.get("offset")); offsets.push(offset);
    return Response.json({ items: composites.slice(offset, offset + 50), total: 75, limit: 50, offset });
  });
  const grades = await readRunRequirementComposites({ run_id: "run", nested: {} });
  const identity = { label: "Requirements" as const, rows };
  const first = selectRequirementGradingRows({ identity, composites: grades.items, page: { limit: 50, offset: 0 } });
  const second = selectRequirementGradingRows({ identity, composites: grades.items, page: { limit: 50, offset: 50 } });
  expect([offsets, first.items.length, second.items.length, second.total]).toEqual([[0, 50], 50, 25, 75]);
  expect([...first.items, ...second.items].map((row) => row.composite?.producer_local_id)).toEqual(rows.map((row) => row.id));
});
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
