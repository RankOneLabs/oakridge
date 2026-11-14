import type { CohortId } from "../run-types";
import type { PlanTraceId } from "./plan";
import { expect, test } from "vitest";
import body from "./__fixtures__/build-items-brief.json";
import { parseBuildBrief } from "./build-brief";
import { selectBuildItemReport, type BuildItemFinding } from "./assessment";
const parsed = parseBuildBrief(body);
if (parsed?.shape !== "build_items") throw new Error("invalid fixture");
const brief = { ...parsed, build_items: [parsed.build_items[0]! /* Fixture above validates a brief containing B1. */, { ...parsed.build_items[0]! /* Fixture above validates a brief containing B1. */, id: "B2" as PlanTraceId }, { ...parsed.build_items[0]! /* Fixture above validates a brief containing B1. */, id: "B3" as PlanTraceId }] };
export const finding = (subjects: BuildItemFinding["subjects"], status: BuildItemFinding["status"] = "partial", index = 0): BuildItemFinding => ({ subjects, status, description: `Finding ${index}`, evidence: [{ kind: "output", ref: "test output", detail: null }], item_path: `/findings/${index}` });

test.each(["not_met", "partial", null] as const)("%s findings need attention", (status) => {
  expect(selectBuildItemReport(brief, [finding([{ kind: "build_item", id: "B1" as PlanTraceId }], status)])[0]?.rows.map((row) => row.item?.id)).toEqual(["B1"]);
});
test("a multi-item finding appears once under each named item", () => {
  const value = finding([{ kind: "build_item", id: "B1" as PlanTraceId }, { kind: "build_item", id: "B2" as PlanTraceId }]);
  expect(selectBuildItemReport(brief, [value])[0]?.rows.map((row) => row.findings)).toEqual([[value], [value]]);
});
test("only unmatched build-item subjects are unresolved, with literal ids and cohort qualifiers", () => {
  const value = finding([{ kind: "task", id: "T1" as PlanTraceId }, { kind: "build_item", id: "B1" as PlanTraceId }, { kind: "build_item", id: "missing" as PlanTraceId }, { kind: "build_item", id: "B1" as PlanTraceId, cohort_id: "other" as CohortId }]);
  expect(selectBuildItemReport(brief, [value]).find((group) => group.label === "Unresolved item references")?.rows[0]?.unresolved_subjects).toEqual([{ kind: "build_item", id: "missing" as PlanTraceId }, { kind: "build_item", id: "B1" as PlanTraceId, cohort_id: "other" as CohortId }]);
});
test("task-only findings remain visible without being unresolved item references", () => {
  const value = finding([{ kind: "task", id: "T1" as PlanTraceId }]);
  const report = selectBuildItemReport(brief, [value]);
  expect([report.find((group) => group.label === "Task findings")?.rows[0]?.findings, report.at(-1)?.rows]).toEqual([[value], []]);
});
test("integration has findings without a per-item comparison", () => {
  const values = [finding([{ kind: "task", id: "T1" as PlanTraceId }]), finding([{ kind: "build_item", id: "B1" as PlanTraceId, cohort_id: "pwa" as CohortId }])];
  expect(selectBuildItemReport(null, values)).toEqual([{ label: "Findings", rows: values.map((value) => ({ item: null, findings: [value] })) }]);
});
