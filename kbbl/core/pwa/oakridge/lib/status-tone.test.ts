import { describe, expect, it } from "vitest";
import type { ChipTone } from "../../components/atoms/Chip";
import type { AssessmentVerdict, ArtifactRevisionStatus, CriterionStatus, FindingSeverity, PrReviewStatus, RequirementStatus, RunDisplayStatus, RunStatus, StageStatus, StageUnitStatus } from "../types";
import { selectStatusTone, type StatusToneSource } from "./status-tone";

const run = {
  pending: "muted", running: "info", parked: "warning", failed: "danger",
  complete: "success", cancelled: "muted",
} satisfies Record<RunStatus, ChipTone>;
const stage = {
  pending: "muted", running: "info", parked: "warning", failed: "danger", complete: "success",
} satisfies Record<StageStatus, ChipTone>;
const unit = {
  pending: "muted", running: "info", parked: "warning", failed: "danger", complete: "success",
} satisfies Record<StageUnitStatus, ChipTone>;
const display = { ...run, stuck: "warning" } satisfies Record<RunDisplayStatus, ChipTone>;
const artifact = { draft: "warning", approved: "success", rejected: "danger" } satisfies Record<ArtifactRevisionStatus, ChipTone>;
const severity = { blocking: "danger", warning: "warning", info: "info" } satisfies Record<FindingSeverity, ChipTone>;
const requirement = { implementable: "success", blocked: "danger", ambiguous: "warning" } satisfies Record<RequirementStatus, ChipTone>;
const criterion = { met: "success", partial: "warning", not_met: "danger" } satisfies Record<CriterionStatus, ChipTone>;
const verdict = { pass: "success", pass_with_notes: "warning", fail: "danger" } satisfies Record<AssessmentVerdict, ChipTone>;
const prReview = {
  draft: "warning", ready: "info", changes_requested: "warning", approved: "success", merged: "success", closed: "muted",
} satisfies Record<PrReviewStatus, ChipTone>;

describe("selectStatusTone", () => {
  it("maps every member of the API status unions", () => {
    for (const mapping of [run, stage, unit, display, artifact, severity, requirement, criterion, verdict, prReview]) {
      for (const [status, tone] of Object.entries(mapping)) {
        expect(selectStatusTone(status as StatusToneSource)).toBe(tone);
      }
    }
  });

  it("falls back to muted for a status string the API unions do not contain", () => {
    expect(selectStatusTone("superseded" as StatusToneSource)).toBe("muted");
  });
});
