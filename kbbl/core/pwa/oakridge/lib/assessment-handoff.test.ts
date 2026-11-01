import { describe, expect, it } from "vitest";
import type { Assessment } from "./assessment";
import { composeHandoffText, NO_REVIEW_REASON, selectHandoffItems, selectHandoffSendability, selectHandoffSendTarget, withItemAdded, withItemRemoved, withItemTextChanged } from "./assessment-handoff";
import type { ParkedGate } from "../types";

const assessment: Assessment = {
  head_sha: null, verdict: "pass_with_notes", findings: [], test_evidence: null,
  recommended_next_actions: [
    { id: "a", text: "Fix the first issue" },
    { id: "b", text: "Add coverage" },
    { id: "c", text: "Document the result" },
  ],
};

const gate: ParkedGate = {
  id: "gate-1", gate_type: "assessment_review", gate_step: "assessment_review", run_id: "run-1", stage_name: "cohort",
  unit_id: "alpha", artifact_revision_id: "assessment-rev", worktree: null, resume_actions: ["approve"],
  offered_decisions: ["request_build_changes"], run_state: "active", actionable: true,
};

describe("assessment handoff", () => {
  it("keeps selection with each action after a preceding action is removed", () => {
    const selected = selectHandoffItems(assessment).map((item) => ({ ...item, is_included: item.id !== "b" }));
    const remaining = selectHandoffItems(withItemRemoved(assessment, "a")).map((item) => ({
      ...item, is_included: selected.find((previous) => previous.id === item.id)?.is_included ?? true,
    }));
    expect(remaining.map((item) => [item.id, item.is_included])).toEqual([["b", false], ["c", true]]);
  });

  it("keeps an action ID when its text changes", () => {
    expect(withItemTextChanged(assessment, "b", "Revised").recommended_next_actions[1]).toEqual({ id: "b", text: "Revised" });
  });

  it("composes only included actions", () => {
    const items = selectHandoffItems(assessment).map((item) => ({ ...item, is_included: item.id !== "b" }));
    expect(composeHandoffText(items)).toBe("Recommended next actions for the builder:\n\n1. Fix the first issue\n2. Document the result");
  });

  it("adds a new action without choosing its identity", () => {
    expect(withItemAdded(assessment, "Cover the error path").recommended_next_actions.at(-1)).toEqual({ text: "Cover the error path" });
  });

  it("derives sent status from a recorded decision", () => {
    expect(selectHandoffSendTarget(gate, true)).toEqual({ kind: "sent" });
  });

  it("offers a new round when no send is recorded for it", () => {
    expect(selectHandoffSendTarget({ ...gate, id: "gate-2" }, false)).toEqual({ kind: "review", gate: { ...gate, id: "gate-2" } });
  });

  it("has no review when neither a gate nor a send exists", () => {
    expect(selectHandoffSendTarget(null, false)).toEqual({ kind: "no_review" });
  });

  it("sends only when the server offers request build changes", () => {
    expect(selectHandoffSendability("1. Fix it", gate)).toEqual({ kind: "sendable", artifact_revision_id: "assessment-rev" });
  });

  it("blocks sending without the offered decision", () => {
    expect(selectHandoffSendability("1. Fix it", { ...gate, offered_decisions: [] }).kind).toBe("blocked");
  });

  it("blocks a review without a target revision", () => {
    expect(selectHandoffSendability("1. Fix it", { ...gate, artifact_revision_id: null })).toEqual({ kind: "blocked", reason: NO_REVIEW_REASON });
  });
});
