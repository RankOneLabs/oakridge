import { describe, expect, it } from "vitest";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { selectReviewValidationRejection } from "./validation-rejection";

const MESSAGE = "Assessment verdict must match item statuses and additional finding severities.";
const rejection = (target: string) => ({ id: "v1", review: "engine:validator", decision: "request_changes", effect: "request_changes", target_revision_id: target,
  payload: { feedback: MESSAGE }, created_at: "2026-11-20T00:00:00Z" }) as OperatorRevisionDecision;
const offered = (target: string): OperatorDecisionDefinition => ({ key: "request_assessment_changes", label: "Request assessment changes", payload_schema: "{feedback: text}", operation: "plain", assessment: "assessment", fields: [],
  submit: { kind: "review", review: "assessment_review", decision: "request_assessment_changes", effect: "request_changes", target_revision_id: target } });

describe("review validation rejection", () => {
  it("names the validator's message on a revision the review decides", () => {
    expect(selectReviewValidationRejection([rejection("assessment:1")], [offered("build:1"), offered("assessment:1")])).toBe(MESSAGE);
  });
  it("ignores a rejection of a revision the review no longer decides", () => {
    expect(selectReviewValidationRejection([rejection("assessment:1")], [offered("assessment:2")])).toBeNull();
  });
});
