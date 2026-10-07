import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorScopeHistory } from "../client";
import { OperatorTypedValue } from "../components/molecules/OperatorTypedValue";
import type { OperatorSchema } from "../operator-contracts";

interface Props { readonly runId: string; readonly scopeId: string; readonly schemas: readonly OperatorSchema[] }
function decisionKind(decision: unknown): string {
  return decision !== null && typeof decision === "object" && "kind" in decision && typeof decision.kind === "string"
    ? decision.kind : "transition";
}
export function OperatorHistoryPane({ runId, scopeId, schemas }: Props) {
  const history = useQuery({ queryKey: queryKeys.history(runId, scopeId), queryFn: () => fetchOperatorScopeHistory(runId, scopeId) });
  return <section data-testid="operator-history-pane"><h3>Scope history</h3>
    {history.isError && <p role="alert">{String(history.error)}</p>}
    {!history.data && !history.isError && <p role="status">Loading history…</p>}
    {history.data && <><h4>Transitions</h4>
      {history.data.transitions.length === 0 && <p>No transitions yet.</p>}
      <ol>{history.data.transitions.map((transition) => <li key={transition.id}>
        <span>Version {transition.version} · {decisionKind(transition.decision)} · {transition.trigger_id}</span>
        <time> {new Date(transition.created_at).toLocaleString()}</time>
      </li>)}</ol><h4>Facts</h4>
      {history.data.facts.length === 0 && <p>No facts yet.</p>}
      <ol>{history.data.facts.map((fact) => <li key={fact.id}><strong>{fact.fact_key}</strong><OperatorTypedValue value={fact.payload} schemas={schemas} /></li>)}</ol>
    </>}
  </section>;
}
