import { describe, expect, it } from "vitest";
import type { ChipTone } from "../../components/atoms/Chip";
import type { AssessmentVerdict, ArtifactRevisionStatus, FindingSeverity, RunDisplayStatus, RunStatus, StageStatus, StageUnitStatus } from "../types";
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
const verdict = { pass: "success", pass_with_notes: "warning", fail: "danger" } satisfies Record<AssessmentVerdict, ChipTone>;

describe("selectStatusTone", () => {
  it("maps every member of the API status unions", () => {
    for (const mapping of [run, stage, unit, display, artifact, severity, verdict]) {
      for (const [status, tone] of Object.entries(mapping)) {
        expect(selectStatusTone(status as StatusToneSource)).toBe(tone);
      }
    }
  });
});
