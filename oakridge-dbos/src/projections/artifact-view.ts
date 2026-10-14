import type { DecisionEffect } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { isEditable, isReviewable, selectArtifactSchema, selectRevisionViews, type ArtifactRevisionView, type BodyValue } from "./unit-view";

/** Review status belongs to the operator projection, not the revision row: the effect of the latest revision's latest decision. */
export type ArtifactRevisionStatus = "draft" | "approved" | "changes_requested";

/** A decision recorded on one of the artifact's revisions. */
export interface RevisionDecision {
  readonly id: string;
  readonly review: string;
  readonly decision: string;
  readonly effect: DecisionEffect;
  readonly target_revision_id: string;
  readonly payload: BodyValue;
  readonly created_at: Date;
}
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
}

export interface ArtifactLocation { readonly unit_id: string; readonly artifact: string }
/** One declared artifact of a stage unit, or null when the unit or its stage does not declare it. */
export function selectArtifactDetail(read: RunRead, location: ArtifactLocation): ArtifactDetail | null {
  const unit = read.units.find((candidate) => candidate.id === location.unit_id);
  const stage = unit?.stage == null ? undefined : read.definition.workflow.stages[unit.stage];
  if (!unit || !stage?.artifacts[location.artifact]) return null;
  const revisions = selectRevisionViews(read.revisions.filter((revision) => revision.unit_id === unit.id && revision.artifact === location.artifact));
  const ids = new Set(revisions.map((revision) => revision.id));
  const decisions = read.decisions.filter((decision) => ids.has(decision.target_revision_id)).map((decision): RevisionDecision => ({
    id: decision.id, review: decision.review, decision: decision.decision, effect: decision.effect,
    target_revision_id: decision.target_revision_id, payload: decision.payload as BodyValue, created_at: decision.created_at }));
  const latest = revisions.at(-1);
  const verdict = latest ? decisions.filter((decision) => decision.target_revision_id === latest.id).at(-1) : undefined;
  return { run_id: unit.run_id, unit_id: unit.id, artifact_key: location.artifact, schema: selectArtifactSchema(stage, location.artifact),
    is_reviewable: isReviewable(stage, location.artifact), is_editable: isEditable(stage, location.artifact),
    status: verdict === undefined ? "draft" : verdict.effect === "approve" ? "approved" : "changes_requested", revisions, decisions };
}
