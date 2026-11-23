import { selectReceivedContextView, type ReceivedContext } from "../../lib/received-context";
export function ReceivedContextPanel({ context }: { context: ReceivedContext }) {
  const view = selectReceivedContextView(context);
  const { assignment, sources } = view;
  return <details className="rounded border-2 border-[var(--border-muted)] bg-[var(--bg-surface)] p-4"><summary>What this agent received</summary>
    <h3>What this agent received</h3><p>Pinned handoff context</p>
    <h4>{assignment.cohort.id}: {assignment.cohort.title}</h4><p>Repository: {assignment.cohort.assigned_repository}</p><p>Scope: {assignment.cohort.change_scope}</p><p>Rationale: {assignment.cohort.decision_reason}</p><p>Dependencies: {view.dependencies_text}</p>
    <h4>Allocations</h4><ul>{assignment.cohort.allocations.map((allocation) => <li key={allocation.requirement_id}>{allocation.requirement_id}: {allocation.contribution}</li>)}</ul>
    {view.requirements.map((requirement) => <section key={requirement.id}><h4>{requirement.id}</h4><p>{requirement.text}</p><ul>{requirement.acceptance_conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul><p>Source revisions: {requirement.source_revisions_text}</p></section>)}
    <h4>Input provenance ({context.provenance_status})</h4><ul>{sources.map((source, i) => <li key={i}>{source.input}: <code>{source.revision_id}</code> ({source.unit})</li>)}</ul>
  </details>;
}
