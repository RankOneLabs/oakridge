import { describe, expect, it } from "vitest";
import type { Assessment } from "./assessment";
import { BUILD_HANDOFF_UNOFFERED_REASON, composeHandoffText, NO_REVIEW_REASON, selectHandoffItems, selectHandoffSendability, selectHandoffSendTarget, withItemAdded, withItemRemoved } from "./assessment-handoff";
import type { ParkedGate } from "../types";
import linkedAssessment from "./__fixtures__/id-linked-assessment.json";

const assessment: Assessment = {
  head_sha: null,
  verdict: "pass_with_notes",
  findings: [{ criterion_id: null, criterion: "Ship it", status: "partial", evidence: { kind: "legacy", text: "Some evidence" }, description: null }],
  test_evidence: null,
  recommended_next_actions: ["Fix the first issue", "Add coverage", "Document the result"],
};

describe("assessment handoff", () => {
  it("composes only included actions", () => {
    const items = selectHandoffItems(assessment).map((item) => item.index === 1 ? { ...item, is_included: false } : item);
    expect(composeHandoffText(items)).toBe("Recommended next actions for the builder:\n\n1. Fix the first issue\n2. Document the result");
  });

  it("uses edited text in the preview", () => {
    const items = selectHandoffItems(assessment).map((item) => item.index === 0 ? { ...item, text: "Fix the revised issue" } : item);
    expect(composeHandoffText(items)).toContain("1. Fix the revised issue");
  });

  it("removes one action and leaves the rest of the body identical", () => {
    const body = { ...assessment, extra_server_field: { retained: true } };
    expect(withItemRemoved(body, 1)).toEqual({ ...body, recommended_next_actions: ["Fix the first issue", "Document the result"] });
  });

  it("appends one action and leaves the rest of the body identical", () => {
    const body = { ...assessment, extra_server_field: { retained: true } };
    expect(withItemAdded(body, "Cover the error path")).toEqual({ ...body,
      recommended_next_actions: ["Fix the first issue", "Add coverage", "Document the result", "Cover the error path"] });
  });

  it("preserves the raw commit and typed evidence on republish", () => {
    const body = { ...linkedAssessment, recommended_next_actions: ["Fix it", "Add coverage"], extra_server_field: { retained: true } };
    const updated = withItemRemoved(body as unknown as Assessment, 0);
    expect(JSON.stringify(updated)).toBe(JSON.stringify({ ...body, recommended_next_actions: ["Add coverage"] }));
  });
});

const gate: ParkedGate = {
  id: "gate-1", gate_type: "assessment_review", gate_step: "assessment_review", run_id: "run-1", stage_name: "cohort",
  unit_id: "alpha", artifact_revision_id: "assessment-rev", worktree: null, resume_actions: ["approve"], is_build_handoff_offered: true, run_state: "active", actionable: true,
};

describe("selectHandoffSendTarget", () => {
  it("offers an open review that has not been sent on", () => {
    expect(selectHandoffSendTarget(gate, null)).toEqual({ kind: "review", gate });
  });

  it("keeps a recorded send while its review is still listed", () => {
    expect(selectHandoffSendTarget(gate, "gate-1")).toEqual({ kind: "sent" });
  });

  it("keeps a recorded send after its review closes", () => {
    expect(selectHandoffSendTarget(null, "gate-1")).toEqual({ kind: "sent" });
  });

  it("offers the next review once the reassessment opens one", () => {
    expect(selectHandoffSendTarget({ ...gate, id: "gate-2" }, "gate-1")).toEqual({ kind: "review", gate: { ...gate, id: "gate-2" } });
  });

  it("has nothing to send on without a review or a send", () => {
    expect(selectHandoffSendTarget(null, null)).toEqual({ kind: "no_review" });
  });
});

describe("selectHandoffSendability", () => {
  it("sends on the review's revision", () => {
    expect(selectHandoffSendability("1. Fix it", gate)).toEqual({ kind: "sendable", artifact_revision_id: "assessment-rev" });
  });

  it("blocks an empty request", () => {
    expect(selectHandoffSendability("", gate)).toEqual({ kind: "blocked", reason: "Include at least one next action to send." });
  });

  it("blocks a review without a revision", () => {
    expect(selectHandoffSendability("1. Fix it", { ...gate, artifact_revision_id: null })).toEqual({ kind: "blocked", reason: NO_REVIEW_REASON });
  });

  it("blocks a review the run has moved past", () => {
    expect(selectHandoffSendability("1. Fix it", { ...gate, actionable: false }))
      .toEqual({ kind: "blocked", reason: "The run has moved on, so this review can no longer take a decision." });
  });

  it("blocks a review whose definition has no build handoff", () => {
    expect(selectHandoffSendability("1. Fix it", { ...gate, is_build_handoff_offered: false }))
      .toEqual({ kind: "blocked", reason: BUILD_HANDOFF_UNOFFERED_REASON });
  });
});
