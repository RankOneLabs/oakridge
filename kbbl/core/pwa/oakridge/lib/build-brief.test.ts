import { describe, expect, test } from "vitest";
import { isBuildBrief } from "./build-brief";

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
  test("accepts the registered artifact body", () => {
    expect(isBuildBrief(validBrief)).toBe(true);
  });

  test("rejects an incomplete decision", () => {
    expect(isBuildBrief({
      ...validBrief,
      decisions_made: [{ decision: "Missing rationale" }],
    })).toBe(false);
  });
});
