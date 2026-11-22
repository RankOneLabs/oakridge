import type { RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import { isEditable, isReviewable, selectArtifactSchema, selectAttemptIntent, selectPublishingAttempt, selectRevisionDecision, selectRevisionViews, type ArtifactRevisionView, type BodyValue, type RevisionDecision } from "./unit-view";

/** Review status belongs to the operator projection, not the revision row: the effect of the latest revision's latest decision. */
export type ArtifactRevisionStatus = "draft" | "approved" | "changes_requested";

/** One declared artifact of a unit: every revision, oldest first, and the decisions on them. */
export interface ArtifactDetail {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  readonly schema: string;
  readonly is_reviewable: boolean;
  /** A review of this artifact declares assessment operations. */
  readonly has_assessment_operations: boolean;
  readonly is_editable: boolean;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: ArtifactRevisionStatus;
  readonly revisions: readonly ArtifactDetailRevision[];
  readonly decisions: readonly RevisionDecision[];
  readonly view: string | null;
  readonly producing_attempt_inputs: BodyValue | null;
}

export interface ArtifactDetailRevision extends ArtifactRevisionView {
  readonly producing_attempt_inputs?: BodyValue | null;
}

export interface ArtifactLocation { readonly unit_id: string; readonly artifact: string }
/** One declared artifact of a stage unit, or null when the unit or its stage does not declare it. */
export function selectArtifactDetail(read: RunRead, location: ArtifactLocation): ArtifactDetail | null {
  const unit = read.units.find((candidate) => candidate.id === location.unit_id);
  const stage = unit?.stage == null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  if (!unit || !stage?.artifacts[location.artifact]) return null;
  const records = read.revisions.filter((revision) => revision.unit_id === unit.id && revision.artifact === location.artifact);
  const byRevision = new Map<string, (typeof records)[number]>(records.map((revision) => [revision.id, revision]));
  const revisions: ArtifactDetailRevision[] = selectRevisionViews({ revisions: records, attempts: read.attempts,
    versions: read.definition.artifact_schema_versions ?? {}, stage: unit.stage ?? "" }).map((revision) => {
      const stored = byRevision.get(revision.id);
      const attempt = stored && selectPublishingAttempt(stored, read.attempts);
      return { ...revision, producing_attempt_inputs: attempt ? selectAttemptIntent(attempt, read.intents)?.inputs ?? null : null };
    });
  const ids = new Set(revisions.map((revision) => revision.id));
  const decisions = read.decisions.map((decision) => selectRevisionDecision(read, decision))
    .filter(decision => ids.has(decision.target_revision_id));
  const latest = revisions.at(-1);
  const verdict = latest ? decisions.filter((decision) => decision.target_revision_id === latest.id).at(-1) : undefined;
  const status = verdict === undefined ? "draft" : verdict.effect === "approve" ? "approved" : "changes_requested";
  const editPolicy = stage.artifacts[location.artifact]?.edit_policy?.kind ?? "always";
  return { run_id: unit.run_id, unit_id: unit.id, artifact_key: location.artifact, schema: selectArtifactSchema(stage, location.artifact),
    is_reviewable: isReviewable(stage, location.artifact), has_assessment_operations: hasAssessmentOperations(stage, location.artifact), is_editable: isEditable(stage, location.artifact) && !(editPolicy === "frozen_when_accepted" && status === "approved"),
    status, revisions, decisions,
    view: stage.artifacts[location.artifact]?.view ?? null,
    producing_attempt_inputs: latest?.producing_attempt_inputs ?? null };
}

export function hasAssessmentOperations(stage: import("../core-client/core-types").ParsedStage, artifact: string): boolean {
  return Object.values(stage.reviews ?? {}).some(review => (review.assessment ?? review.of) === artifact
    && Object.values(review.decisions).some(decision => decision.operation !== undefined && decision.operation !== "plain"));
}
