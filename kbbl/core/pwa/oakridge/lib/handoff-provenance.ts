import { parseCompositeId } from "../adapters/core";
import type { OperatorAttemptView, OperatorArtifactRevisionView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { parseBuildBrief } from "./build-brief";
export interface HandoffBriefProvenance { revision_id: string | null; build_item_ids: string[] | null }
/** Only the exact recorded input revision can supply item ids. */
export function selectHandoffBrief(attempt: Pick<OperatorAttemptView, "intent"> | null, revisions: readonly Pick<OperatorArtifactRevisionView, "id" | "unit_id" | "body">[]): HandoffBriefProvenance {
  const provenance = attempt?.intent?.input_provenance;
  const reference = provenance?.status === "recorded" ? provenance.entries.find((entry) => entry.input === "brief") : null;
  if (!reference) return { revision_id: null, build_item_ids: null };
  const revision = revisions.find((candidate) => candidate.id === reference.revision_id && candidate.unit_id === reference.unit);
  const brief = revision ? parseBuildBrief(revision.body) : null;
  return { revision_id: reference.revision_id, build_item_ids: brief?.shape === "build_items" ? brief.build_items.map((item) => item.id) : null };
}

export interface HandoffContextRequest {
  unit: import("../operator-contracts/projections/unit-view").OperatorUnitView | null;
  revisions: readonly OperatorArtifactRevisionView[];
  attemptId?: string;
  revisionId?: string;
}
/** Accept artifact pane identities as well as authority revision ids. */
export function selectHandoffRevisionId(id: string | undefined): string | null {
  if (!id) return null;
  const parsed = parseCompositeId(id, "artifact");
  return parsed.ok ? parsed.value.name.slice(parsed.value.name.indexOf(":") + 1) : id;
}
/** The unit that owns an artifact pane's revision; a cohort label is not a unit identity. */
export function selectHandoffUnitId(revisionId: string): string | null {
  const parsed = parseCompositeId(revisionId, "artifact");
  return parsed.ok ? parsed.value.unitId : null;
}
export function selectHandoffUnit(units: readonly OperatorUnitView[], id: string | null | undefined): OperatorUnitView | null {
  return id == null ? null : units.find((unit) => unit.unit_id === id || unit.label === id) ?? null;
}
export function selectHandoffContext({ unit, revisions, attemptId, revisionId }: HandoffContextRequest) {
  const assessmentRevision = revisions.find((revision) => revision.id === selectHandoffRevisionId(revisionId));
  const attempt = unit?.attempts.find((candidate) => candidate.id === (attemptId ?? assessmentRevision?.attempt_id)) ?? null;
  const assessor = attempt?.intent?.engine_inputs.subject || assessmentRevision?.subject_id ? attempt : null;
  const resultId = assessmentRevision?.subject_id ?? assessor?.intent?.engine_inputs.subject?.id ?? null;
  const buildRevision = revisions.find((revision) => revision.id === selectHandoffRevisionId(resultId ?? undefined));
  const builder = attempt && !assessor ? attempt : unit?.attempts.find((candidate) => candidate.id === buildRevision?.attempt_id) ?? null;
  return { builder, assessor, resultId };
}
export function selectHandoffBriefUnit(attempt: OperatorAttemptView | null): string | null {
  const provenance = attempt?.intent?.input_provenance;
  return provenance?.status === "recorded" ? provenance.entries.find((entry) => entry.input === "brief")?.unit ?? null : null;
}
export function selectHandoffRevisions(histories: readonly import("../operator-contracts/projections/artifact-view").OperatorArtifactDetail[] | undefined): OperatorArtifactRevisionView[] {
  return histories?.flatMap((artifact) => artifact.revisions) ?? [];
}

export interface HandoffProvenanceRequest {
  run_id: string;
  units: readonly OperatorUnitView[];
  builder: OperatorAttemptView | null;
  assessor: OperatorAttemptView | null;
  unit_revisions: readonly OperatorArtifactRevisionView[];
  builder_brief_revisions: readonly OperatorArtifactRevisionView[];
  assessor_brief_revisions: readonly OperatorArtifactRevisionView[];
}
/** Each worker's recorded brief, and the revision index its links resolve against. */
export function selectHandoffProvenance({ run_id, units, builder, assessor, unit_revisions, builder_brief_revisions, assessor_brief_revisions }: HandoffProvenanceRequest) {
  const brief_revisions = [...builder_brief_revisions, ...assessor_brief_revisions];
  return { builder_brief: selectHandoffBrief(builder, brief_revisions), assessor_brief: selectHandoffBrief(assessor, brief_revisions),
    index: { run_id, units, revisions: [...brief_revisions, ...unit_revisions] } };
}
