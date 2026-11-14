import { formatRunWorkspaceHash } from "../../../lib/hash";
import { selectRevisionLink } from "../../lib/recorded-relationships";
import { useOperatorUnits } from "../../hooks/useOperatorUnits";
import { useStageArtifactHistories } from "../../hooks/useStageArtifactHistories";
import { selectHandoffBrief } from "../../lib/handoff-provenance";
interface Props { runId: string; unitId: string; attemptId?: string; revisionId?: string }
export function HandoffProvenance({ runId, unitId, attemptId, revisionId }: Props) {
  const units = useOperatorUnits(runId);
  const unit = units.data?.find((candidate) => candidate.unit_id === unitId || candidate.label === unitId) ?? null;
  const unitHistory = useStageArtifactHistories(unit);
  const unitRevisions = unitHistory.data?.flatMap((artifact) => artifact.revisions) ?? [];
  const assessmentRevision = unitRevisions.find((revision) => revision.id === revisionId);
  const attempt = unit?.attempts.find((candidate) => candidate.id === (attemptId ?? assessmentRevision?.attempt_id)) ?? null;
  const assessor = attempt?.worker === "assessor" ? attempt : null;
  const subjectId = assessmentRevision?.subject_id ?? assessor?.intent?.engine_inputs.subject?.id ?? null;
  const buildRevision = unitRevisions.find((revision) => revision.id === subjectId);
  const builder = attempt?.worker === "builder" ? attempt : unit?.attempts.find((candidate) => candidate.id === buildRevision?.attempt_id) ?? null;
  const provenance = (builder ?? assessor)?.intent?.input_provenance;
  const briefUnitId = provenance?.status === "recorded" ? provenance.entries.find((entry) => entry.input === "brief")?.unit : null;
  const briefUnit = units.data?.find((candidate) => candidate.unit_id === briefUnitId) ?? null;
  const histories = useStageArtifactHistories(briefUnit);
  const revisions = histories.data?.flatMap((artifact) => artifact.revisions) ?? [];
  const builderBrief = selectHandoffBrief(builder, revisions), assessorBrief = selectHandoffBrief(assessor, revisions);
  const resultId = assessmentRevision?.subject_id ?? assessor?.intent?.engine_inputs.subject?.id ?? null;
  const index = { run_id: runId, units: units.data ?? [], revisions: [...revisions, ...unitRevisions] };
  const renderRevision = (id: string | null) => {
    const link = selectRevisionLink(index, { kind: "effect_input_revision", revision_id: id, label: "Revision" });
    return link.resolution.state === "resolved" && link.resolution.target.pane.kind === "artifact" ? <a href={`#${formatRunWorkspaceHash(runId, link.resolution.target.pane)}`}>{id}</a> : <span>{id ?? "Unresolved"}{id ? " (unresolved)" : ""}</span>;
  };
  return <section aria-label="Handoff provenance"><h3>Handoff provenance</h3><dl>
    <dt>Builder brief revision</dt><dd>{renderRevision(builderBrief.revision_id)}</dd>
    <dt>Build items in builder brief</dt><dd>{builderBrief.build_item_ids?.join(", ") ?? "Unresolved"}</dd>
    <dt>Assessor brief revision</dt><dd>{renderRevision(assessorBrief.revision_id)}</dd>
    <dt>Build result revision</dt><dd>{renderRevision(resultId)}</dd>
  </dl></section>;
}
