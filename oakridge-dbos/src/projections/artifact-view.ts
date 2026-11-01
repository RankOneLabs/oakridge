import type { RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { isEditable, isReviewable, selectArtifactSchema, selectRevisionDecision, selectRevisionViews, type ArtifactRevisionView, type RevisionDecision } from "./unit-view";

/** Review status belongs to the operator projection, not the revision row: the effect of the latest revision's latest decision. */
export type ArtifactRevisionStatus = "draft" | "approved" | "changes_requested";

/** One declared artifact of a unit: every revision, oldest first, and the decisions on them. */
export interface ArtifactDetail {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  readonly schema: string;
  readonly is_reviewable: boolean;
  readonly is_editable: boolean;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: ArtifactRevisionStatus;
  readonly revisions: readonly ArtifactRevisionView[];
  readonly decisions: readonly RevisionDecision[];
  /** The launch spec, retained for comparing a published revised spec. */
  readonly original_spec: string | null;
}

function originalSpec(read: RunRead, location: ArtifactLocation): string | null {
  if (location.artifact !== "spec") return null;
  const input = read.run.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const spec = (input as { readonly spec?: unknown }).spec;
  return typeof spec === "string" ? spec : null;
}

export interface ArtifactLocation { readonly unit_id: string; readonly artifact: string }
/** One declared artifact of a stage unit, or null when the unit or its stage does not declare it. */
export function selectArtifactDetail(read: RunRead, location: ArtifactLocation): ArtifactDetail | null {
  const unit = read.units.find((candidate) => candidate.id === location.unit_id);
  const stage = unit?.stage == null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  if (!unit || !stage?.artifacts[location.artifact]) return null;
  const revisions = selectRevisionViews(read.revisions.filter((revision) => revision.unit_id === unit.id && revision.artifact === location.artifact));
  const ids = new Set(revisions.map((revision) => revision.id));
  const decisions = read.decisions.filter((decision) => ids.has(decision.target_revision_id)).map(selectRevisionDecision);
  const latest = revisions.at(-1);
  const verdict = latest ? decisions.filter((decision) => decision.target_revision_id === latest.id).at(-1) : undefined;
  const status = verdict === undefined ? "draft" : verdict.effect === "approve" ? "approved" : "changes_requested";
  const editPolicy = stage.artifacts[location.artifact]?.edit_policy?.kind ?? "always";
  return { run_id: unit.run_id, unit_id: unit.id, artifact_key: location.artifact, schema: selectArtifactSchema(stage, location.artifact),
    is_reviewable: isReviewable(stage, location.artifact), is_editable: !read.run.historical_read_only
      && isEditable(stage, location.artifact) && !(editPolicy === "frozen_when_accepted" && status === "approved"),
    status, revisions, decisions,
    original_spec: originalSpec(read, location) };
}
