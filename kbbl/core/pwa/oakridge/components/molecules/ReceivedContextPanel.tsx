import type { ReceivedContext } from "../../lib/received-context";
export function ReceivedContextPanel({ context }: { context: ReceivedContext }) {
  const { assignment, sources } = context;
  return <details className="rounded border-2 border-[var(--border-muted)] bg-[var(--bg-surface)] p-4"><summary>What this agent received</summary>
    <h3>What this agent received</h3><p>Pinned handoff context</p>
    <h4>{assignment.cohort.id}: {assignment.cohort.title}</h4><p>Repository: {assignment.cohort.repository_key}</p><p>Scope: {assignment.cohort.scope}</p><p>Rationale: {assignment.cohort.rationale}</p><p>Dependencies: {assignment.cohort.depends_on.join(", ") || "None"}</p>
    <h4>Allocations</h4><ul>{assignment.cohort.allocations.map((allocation) => <li key={allocation.requirement_id}>{allocation.requirement_id}: {allocation.contribution}</li>)}</ul>
    {assignment.requirements.map((requirement) => <section key={requirement.id}><h4>{requirement.id}</h4><p>{requirement.text}</p><ul>{requirement.acceptance_conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul><p>Source revisions: {sources.filter((source) => source.input === "assignment").map((source) => source.revision_id).join(", ") || "Not recorded"}</p></section>)}
    <h4>Input provenance ({context.provenance_status})</h4><ul>{sources.map((source, i) => <li key={i}>{source.input}: <code>{source.revision_id}</code> ({source.unit})</li>)}</ul>
  </details>;
}
