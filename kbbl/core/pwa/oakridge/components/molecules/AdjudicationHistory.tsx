import type { OperatorRevisionDecision } from "../../operator-contracts/projections/unit-view";
import { ArtifactSection } from "./ArtifactSection";
import { Chip } from "../../../components/atoms/Chip";
interface Props { decisions: readonly OperatorRevisionDecision[]; revisionId: string }
export function AdjudicationHistory({ decisions, revisionId }: Props) {
  return <ArtifactSection title="Recorded action history" testId="or-adjudication-history">
    {decisions.length === 0 && <p>No dispositions have been recorded.</p>}
    {decisions.map(decision => decision.adjudication && <section key={decision.id} className="rounded-md border border-[var(--border-decorative)] p-3">
      <p><Chip tone="neutral">Recorded</Chip> {decision.decision} · {decision.created_at}</p>
      <p>Assessment revision: <code>{decision.assessment_revision_id ?? decision.target_revision_id}</code>{(decision.assessment_revision_id ?? decision.target_revision_id) === revisionId ? " (displayed revision)" : ""}</p>
      <p>Actor: {decision.actor?.kind === "operator" ? decision.actor.subject : decision.actor?.kind ?? "unavailable"}</p>
      <ul>{decision.adjudication.entries.map(entry => <li key={entry.action_id}>
        <strong>{entry.disposition}</strong> · {entry.audience} · <code>{entry.action_id}</code>
        <p>Supporting {entry.source.kind}: {entry.source.id}</p><p>Original: {entry.original_text}</p>{entry.final_text != null && <p>Final: {entry.final_text}</p>}{entry.reason && <p>Reason: {entry.reason}</p>}
      </li>)}{decision.adjudication.added_actions.map(entry => <li key={entry.action_id}>Added by operator · {entry.audience} · {entry.final_text}{entry.reason && <p>Reason: {entry.reason}</p>}</li>)}</ul>
      <strong>{decision.effect === "request_changes" ? "Transmitted builder feedback" : "Recorded builder preview"}</strong><pre className="whitespace-pre-wrap">{decision.adjudication.builder_feedback || "No builder feedback."}</pre>
    </section>)}
  </ArtifactSection>;
}
