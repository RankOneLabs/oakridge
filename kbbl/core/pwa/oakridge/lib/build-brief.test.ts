import { describe, expect, test } from "vitest";
import { isBuildBrief, readBuildBrief } from "./build-brief";
import legacyBrief from "./__fixtures__/legacy-brief.json";
import linkedBrief from "./__fixtures__/id-linked-brief.json";
import linkedPlan from "./__fixtures__/id-linked-plan.json";

const validBrief = {
  cohort_id: "brief-ui",
  repository_key: "oakridge",
  title: "Build brief review UI",
  depends_on: [],
  goal: "Make the brief reviewable.",
  files_in_scope: ["kbbl/core/pwa/oakridge"],
  decisions_made: [{ decision: "Reuse v1", rationale: "It is proven." }],
  approaches_rejected: [{ approach: "Duplicate UI", reason: "It would drift." }],
  acceptance_criteria: ["Operator can approve the artifact."],
  next_action: "Open the brief artifact.",
};

describe("isBuildBrief", () => {
  test("accepts fixture revisions of both generations", () => {
    expect(isBuildBrief(legacyBrief)).toBe(true);
    expect(isBuildBrief(linkedBrief)).toBe(true);
    expect(readBuildBrief(linkedBrief)?.decisions_made[1]?.decision).toBe("Add a compact trace section.");
  });

  test("preserves criterion ids across reordering and rewording", () => {
    const brief = readBuildBrief(linkedBrief);
    expect(brief?.acceptance_criteria.map((criterion) => typeof criterion === "string" ? null : criterion.id)).toEqual(["criterion-brief", "criterion-plan"]);
    expect(brief?.acceptance_criteria[0]).toMatchObject({ id: linkedPlan.cohorts[0].acceptance_criteria[1]?.id, text: "The brief remains readable." });
  });

  test("accepts a new brief decision and a rejected approach with no decision links", () => {
    const brief = readBuildBrief(linkedBrief);
    expect(brief?.decisions_made[1]).toMatchObject({ id: "decision-new" });
    expect(brief?.approaches_rejected[1]).toMatchObject({ decision_ids: [] });
  });

  test.each(["decisions_made", "approaches_rejected", "acceptance_criteria"] as const)("rejects mixed %s generations", (field) => {
    expect(isBuildBrief({ ...linkedBrief, [field]: [legacyBrief[field][0], linkedBrief[field][0]] })).toBe(false);
  });

  test("accepts the registered artifact body", () => {
    expect(isBuildBrief(validBrief)).toBe(true);
  });

  test("rejects an incomplete decision", () => {
    expect(isBuildBrief({
      ...validBrief,
      decisions_made: [{ decision: "Missing rationale" }],
    })).toBe(false);
  });

  test.each(["cohort_id", "repository_key"] as const)("rejects an empty %s", (field) => {
    expect(isBuildBrief({ ...validBrief, [field]: "   " })).toBe(false);
  });
});
