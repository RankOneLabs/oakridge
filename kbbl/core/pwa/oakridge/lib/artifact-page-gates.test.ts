import { describe, expect, it } from "vitest";
import type { ParkedGate } from "../artifact-types";
import { selectArtifactPageGates } from "./artifact-page-gates";

const sliceGate: ParkedGate = {
  id: "slice-review", gate_type: "artifact_approval", gate_step: "slice_report_review",
  run_id: "study", unit_id: "slice", stage_name: "design", artifact_revision_id: "plan:1",
  assessment_revision_id: "slice_assessment:2", worktree: null, resume_actions: ["change_design", "send_to_builder"],
  offered_decisions: ["change_design", "expand", "send_feedback_to_builder", "send_to_builder"],
  requires_adjudication: true, run_state: "active", actionable: true,
};

describe("artifact page gates", () => {
  it("attaches the adjudication to the slice assessment page", () => {
    expect(selectArtifactPageGates({ gates: [sliceGate], revision_ids: new Set(["slice_assessment:1", "slice_assessment:2"]) }))
      .toEqual({ artifactGate: null, adjudicationGate: sliceGate });
  });
  it("attaches plain slice decisions to the plan page", () => {
    expect(selectArtifactPageGates({ gates: [sliceGate], revision_ids: new Set(["plan:1"]) }))
      .toEqual({ artifactGate: sliceGate, adjudicationGate: null });
  });
  it("matches the development assessment gate both ways", () => {
    const gate = { ...sliceGate, gate_step: "assessment_review", artifact_revision_id: "assessment:1", assessment_revision_id: "assessment:1" };
    expect(selectArtifactPageGates({ gates: [gate], revision_ids: new Set(["assessment:1"]) }))
      .toEqual({ artifactGate: gate, adjudicationGate: gate });
  });
});
