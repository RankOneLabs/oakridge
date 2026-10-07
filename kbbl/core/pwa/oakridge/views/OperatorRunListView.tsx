import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRuns } from "../client";
import { Button } from "../../components/atoms/Button";

interface Props { readonly onSelectRun: (id: string) => void; readonly onNewRun: () => void; readonly onDefinitions: () => void }
export function OperatorRunListView({ onSelectRun, onNewRun, onDefinitions }: Props) {
  const runs = useQuery({ queryKey: queryKeys.runs, queryFn: fetchOperatorRuns });
  return <main className="or-page" data-testid="or-run-list">
    <header className="or-page-header"><h1 className="or-page-title">Runs</h1>
      <Button onClick={onNewRun}>Launch run</Button><Button variant="secondary" onClick={onDefinitions}>Definitions</Button></header>
    {runs.isError && <p role="alert">{String(runs.error)}</p>}
    {!runs.data && !runs.isError && <p role="status">Loading runs…</p>}
    {runs.data?.length === 0 && <p>No runs yet.</p>}
    <ul>{runs.data?.map((run) => <li key={run.run_id}>
      <Button variant="secondary" onClick={() => onSelectRun(run.run_id)}>{run.run_id}</Button>
      <span> {run.scopes.filter((scope) => scope.is_terminal).length}/{run.scopes.length} scopes complete</span>
    </li>)}</ul>
  </main>;
}
