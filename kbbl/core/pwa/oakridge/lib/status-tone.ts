import type { ChipTone } from "../../components/atoms/Chip";
import type { AssessmentVerdict, ArtifactRevisionStatus, FindingSeverity, PrReviewStatus, RunDisplayStatus, RunStatus, StageStatus, StageUnitStatus } from "../types";

const RUN_TONE = {
  pending: "muted", active: "info", blocked: "warning", failed: "danger",
  complete: "success", cancelled: "muted",
} satisfies Record<RunStatus, ChipTone>;

const STAGE_TONE = {
  pending: "muted", active: "info", blocked: "warning", failed: "danger", complete: "success", cancelled: "muted",
} satisfies Record<StageStatus, ChipTone>;

const UNIT_TONE = {
  pending: "muted", active: "info", blocked: "warning", failed: "danger", complete: "success", cancelled: "muted",
} satisfies Record<StageUnitStatus, ChipTone>;

const DISPLAY_TONE = { ...RUN_TONE } satisfies Record<RunDisplayStatus, ChipTone>;
const ARTIFACT_TONE = { unreviewed: "warning", accepted: "success", changes_requested: "danger" } satisfies Record<ArtifactRevisionStatus, ChipTone>;
const SEVERITY_TONE = { blocking: "danger", warning: "warning", info: "info" } satisfies Record<FindingSeverity, ChipTone>;
const VERDICT_TONE = { pass: "success", pass_with_notes: "warning", fail: "danger" } satisfies Record<AssessmentVerdict, ChipTone>;
// `draft` and `approved` share a key with ArtifactRevisionStatus, so they must keep the same tone.
const PR_REVIEW_TONE = {
  draft: "warning", ready: "info", changes_requested: "warning", approved: "success", merged: "success", closed: "muted",
} satisfies Record<PrReviewStatus, ChipTone>;

export type StatusToneSource = RunDisplayStatus | StageStatus | StageUnitStatus | ArtifactRevisionStatus | FindingSeverity | AssessmentVerdict | PrReviewStatus;

const STATUS_TONE: Record<StatusToneSource, ChipTone> = {
  ...STAGE_TONE, ...UNIT_TONE, ...DISPLAY_TONE, ...ARTIFACT_TONE, ...SEVERITY_TONE, ...VERDICT_TONE, ...PR_REVIEW_TONE,
};

// Artifact viewers cast JSON strings to these unions, so an unknown value can still arrive.
export function selectStatusTone(status: StatusToneSource): ChipTone {
  return STATUS_TONE[status] ?? "muted";
}
