import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorUnitHistory } from "../client";

interface Props { readonly runId: string; readonly unitId: string }
/** The events that addressed a unit, newest first, each with who wrote it. */
export function OperatorHistoryPane({ runId, unitId }: Props) {
  const history = useQuery({ queryKey: queryKeys.history(runId, unitId), queryFn: () => fetchOperatorUnitHistory(runId, unitId) });
  return <section data-testid="operator-history-pane"><h3>Unit history</h3>
    {history.isError && <p role="alert">{String(history.error)}</p>}
    {!history.data && !history.isError && <p role="status">Loading history…</p>}
    {history.data && <><h4>Events</h4>
      {history.data.events.length === 0 && <p>No events yet.</p>}
      <ol>{history.data.events.map((entry) => <li key={entry.id}>
        <span>{entry.event.kind} · {entry.writer.kind}{entry.ingress_id ? ` · ${entry.ingress_id}` : ""}</span>
        <time> {new Date(entry.created_at).toLocaleString()}</time>
      </li>)}</ol>
    </>}
  </section>;
}
