import { expect, test } from "vitest";
import briefBody from "./__fixtures__/build-items-brief.json";
import legacyBody from "./__fixtures__/id-linked-brief.json";
import assessmentBody from "./__fixtures__/id-linked-assessment.json";
import { parseBuildBrief } from "./build-brief";
import { parseAssessment, selectBuildItemReport } from "./assessment";
import { definitionWithTaskSource, definitionWithScope, definitionSummaries } from "./grading-config";

test("dispatches brief shapes and rejects neither-shape bodies", () => {
  expect([parseBuildBrief(briefBody)?.shape, parseBuildBrief(legacyBody)?.shape, parseBuildBrief({})]).toEqual(["build_items", "legacy", null]);
});
test("subjects remain subjects, and items without findings are not assessed", () => {
  const brief = parseBuildBrief(briefBody);
  const parsed = parseAssessment({ ...assessmentBody, findings: [{ subjects: [{ kind: "build_item", id: "B1" }], status: "met", evidence: [], description: "Judgment" }, { subjects: [], status: "partial", evidence: [], description: "Cross cutting" }] });
  if (brief?.shape !== "build_items" || !parsed.ok || parsed.value.shape !== "build_items") throw new Error("fixture invalid");
  const report = selectBuildItemReport({ ...brief, build_items: [...brief.build_items, { ...brief.build_items[0]!, id: "B2" as typeof brief.build_items[0]["id"] }] }, parsed.value.findings);
  expect(report.map((group) => [group.label, group.rows.length])).toEqual([["Needs attention", 0], ["Not assessed", 1], ["Met (assessor's judgment)", 1], ["Cross-cutting findings", 1], ["Task findings", 0], ["Unresolved item references", 0]]);
});
test("switching task scope drops incompatible fields and summaries name the source", () => {
  const resolved = definitionWithTaskSource({ scope: "per_task", task_ids: "/task_ids" }, "resolved_assesses");
  expect([resolved, definitionWithTaskSource(resolved, "task_ids"), definitionWithScope(resolved, "per_item"), definitionSummaries([resolved])[0]?.scope]).toEqual([{ scope: "per_task", task_source: "resolved_assesses" }, { scope: "per_task", task_ids: "" }, { scope: "per_item" }, "per_task (resolved_assesses)"]);
});
