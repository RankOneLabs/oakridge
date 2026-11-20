import { expect, test } from "vitest";
import briefBody from "./__fixtures__/build-items-brief.json";
import legacyBody from "./__fixtures__/id-linked-brief.json";
import { parseBuildBrief } from "./build-brief";
import { definitionWithTaskSource, definitionWithScope, definitionSummaries } from "./grading-config";

test("dispatches brief shapes and rejects neither-shape bodies", () => {
  expect([parseBuildBrief(briefBody)?.shape, parseBuildBrief(legacyBody)?.shape, parseBuildBrief({})]).toEqual(["build_items", "legacy", null]);
});
test("switching task scope drops incompatible fields and summaries name the source", () => {
  const resolved = definitionWithTaskSource({ scope: "per_task", task_ids: "/task_ids" }, "resolved_assesses");
  expect([resolved, definitionWithTaskSource(resolved, "task_ids"), definitionWithScope(resolved, "per_item"), definitionSummaries([resolved])[0]?.scope]).toEqual([{ scope: "per_task", task_source: "resolved_assesses" }, { scope: "per_task", task_ids: "" }, { scope: "per_item" }, "per_task (resolved_assesses)"]);
});
