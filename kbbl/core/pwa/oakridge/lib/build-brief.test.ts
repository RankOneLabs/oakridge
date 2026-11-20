import type { PlanTraceId } from "./plan";
import buildItemsBrief from "./__fixtures__/build-items-brief.json";
import { describe, expect, test } from "vitest";
import { readBuildBrief, parseBuildBrief, selectBuildItemDecisions } from "./build-brief";
import linkedBrief from "./__fixtures__/id-linked-brief.json";
import linkedPlan from "./__fixtures__/id-linked-plan.json";

const validBrief = {
  cohort_id: "brief-ui",
  repository_key: "oakridge",
  title: "Build brief review UI",
  depends_on: [],
  goal: "Make the brief reviewable.",
  files_in_scope: ["kbbl/core/pwa/oakridge"],
  decisions_made: [{ id: "reuse-v1", decision: "Reuse v1", rationale: "It is proven." }],
  approaches_rejected: [{ id: "duplicate-ui", approach: "Duplicate UI", reason: "It would drift.", decision_ids: ["reuse-v1"] }],
  acceptance_criteria: [{ id: "can-approve", text: "Operator can approve the artifact.", decision_ids: [] }],
  next_action: "Open the brief artifact.",
};

describe("readBuildBrief on a legacy brief", () => {
  test("accepts the linked fixture and reads its decisions", () => {
    expect(readBuildBrief(linkedBrief)?.decisions_made[1]?.decision).toBe("Add a compact trace section.");
  });

  test("preserves task ids across reordering and rewording", () => {
    const brief = readBuildBrief(linkedBrief);
    expect(brief?.shape === "legacy" ? brief.acceptance_criteria.map((criterion) => criterion.id) : null).toEqual(["criterion-brief", "criterion-plan"]);
    expect(brief?.shape === "legacy" ? brief.acceptance_criteria[0] : null).toMatchObject({ id: linkedPlan.cohorts[0].acceptance_criteria[1]?.id, text: "The brief remains readable." });
  });

  test("accepts a new brief decision and a rejected approach with no decision links", () => {
    const brief = readBuildBrief(linkedBrief);
    expect(brief?.decisions_made[1]).toMatchObject({ id: "decision-new" });
    expect(brief?.approaches_rejected[1]).toMatchObject({ decision_ids: [] });
  });

});

describe("readBuildBrief", () => {
  test("reads a body that breaks the contract as null", () => {
    expect(readBuildBrief({ ...validBrief, acceptance_criteria: ["Operator can approve the artifact."] })).toBeNull();
  });
});

test("build item decisions resolve only within their own brief", () => {
  const brief = parseBuildBrief(buildItemsBrief);
  if (brief?.shape !== "build_items") throw new Error("expected build-items fixture");
  const item = brief.build_items[0];
  if (!item) throw new Error("fixture needs a build item");
  expect(selectBuildItemDecisions(brief, { ...item, decision_ids: ["decision-new", "missing"] as PlanTraceId[] })).toEqual([
    { id: "decision-new", decision: "Add a compact trace section." },
    { id: "missing", decision: null },
  ]);
});
