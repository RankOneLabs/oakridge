import { formatRunWorkspaceHash } from "../../../lib/hash";
import { selectRevisionLink } from "../../lib/recorded-relationships";
import { useOperatorUnits } from "../../hooks/useOperatorUnits";
import { useStageArtifactHistories } from "../../hooks/useStageArtifactHistories";
import { selectHandoffBrief, selectHandoffContext, selectHandoffUnit, selectHandoffBriefUnit, selectHandoffRevisions } from "../../lib/handoff-provenance";
interface Props { runId: string; unitId: string; attemptId?: string; revisionId?: string }
export function HandoffProvenance({ runId, unitId, attemptId, revisionId }: Props) {
  const units = useOperatorUnits(runId);
  const unit = selectHandoffUnit(units.data ?? [], unitId);
  const unitHistory = useStageArtifactHistories(unit);
  const unitRevisions = selectHandoffRevisions(unitHistory.data);
  const { builder, assessor, resultId } = selectHandoffContext({ unit, revisions: unitRevisions, attemptId, revisionId });
  const builderHistory = useStageArtifactHistories(selectHandoffUnit(units.data ?? [], selectHandoffBriefUnit(builder)));
  const assessorHistory = useStageArtifactHistories(selectHandoffUnit(units.data ?? [], selectHandoffBriefUnit(assessor)));
  const revisions = [...selectHandoffRevisions(builderHistory.data), ...selectHandoffRevisions(assessorHistory.data)];
  const builderBrief = selectHandoffBrief(builder, revisions), assessorBrief = selectHandoffBrief(assessor, revisions);
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
