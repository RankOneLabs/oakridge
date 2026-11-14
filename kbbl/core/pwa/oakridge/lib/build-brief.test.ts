import { describe, expect, test } from "vitest";
import { isBuildBrief, readBuildBrief } from "./build-brief";
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

describe("isBuildBrief", () => {
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

  test("accepts the registered artifact body", () => {
    expect(isBuildBrief(validBrief)).toBe(true);
  });

  test.each([
    ["a string criterion", { acceptance_criteria: ["Operator can approve the artifact."] }],
    ["a string among object criteria", { acceptance_criteria: [...validBrief.acceptance_criteria, "Operator can approve the artifact."] }],
    ["a criterion with no id", { acceptance_criteria: [{ text: "Approve.", decision_ids: [] }] }],
    ["a criterion with no decision_ids", { acceptance_criteria: [{ id: "can-approve", text: "Approve." }] }],
    ["a string decision", { decisions_made: ["Reuse v1"] }],
    ["a decision with no id", { decisions_made: [{ decision: "Reuse v1", rationale: "It is proven." }] }],
    ["a decision with no rationale", { decisions_made: [{ id: "reuse-v1", decision: "Reuse v1" }] }],
    ["a rejected approach with no id", { approaches_rejected: [{ approach: "Duplicate UI", reason: "It would drift.", decision_ids: [] }] }],
    ["a rejected approach with no decision_ids", { approaches_rejected: [{ id: "duplicate-ui", approach: "Duplicate UI", reason: "It would drift." }] }],
  ])("refuses %s", (_, fields) => {
    expect(isBuildBrief({ ...validBrief, ...fields })).toBe(false);
  });

  test.each(["cohort_id", "repository_key"] as const)("rejects an empty %s", (field) => {
    expect(isBuildBrief({ ...validBrief, [field]: "   " })).toBe(false);
  });
});

describe("readBuildBrief", () => {
  test("reads a body that breaks the contract as null", () => {
    expect(readBuildBrief({ ...validBrief, acceptance_criteria: ["Operator can approve the artifact."] })).toBeNull();
  });
});
