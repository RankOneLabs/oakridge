import type { OperatorRecordedFeedbackDisposition } from "../../operator-contracts/storage/read-store";

const descriptions: Record<OperatorRecordedFeedbackDisposition["kind"], string> = {
  proposal_rejected: "Proposal rejected",
  follow_up_rejected: "Follow-up rejected",
  dispatched: "Feedback dispatched",
  approved: "Assessment approved",
};

export function OperatorActionsHistory({ facts }: { facts: readonly OperatorRecordedFeedbackDisposition[] }) {
  if (!facts.length) return null;
  return <section aria-label="Assessment actions">
    <h4 className="or-run-overview__heading">Assessment actions</h4>
    <ul className="or-run-overview__list">
      {facts.map((fact, index) => <li key={`${fact.decision_id}/${index}`} className="text-sm">
        <div>{descriptions[fact.kind]}</div>
        {fact.reason && <p>{fact.reason}</p>}
        {fact.actor && <span>{fact.actor} · </span>}
        <time dateTime={fact.created_at}>{new Date(fact.created_at).toLocaleString()}</time>
      </li>)}
    </ul>
  </section>;
}
