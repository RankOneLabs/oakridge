import { queryKeys } from "../queryKeys";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorRuns, setOperatorRunArchived } from "../client";
import { Button } from "../../components/atoms/Button";
import { invalidateRunLists } from "../lib/operator-invalidation";

interface Props { readonly onSelectRun: (id: string) => void; readonly onNewRun: () => void; readonly onDefinitions: () => void; readonly onProjects: () => void }
export function OperatorRunListView({ onSelectRun, onNewRun, onDefinitions, onProjects }: Props) {
  const client = useQueryClient();
  const [isShowingArchived, setIsShowingArchived] = useState(false);
  const runs = useQuery({ queryKey: queryKeys.runList(isShowingArchived), queryFn: () => fetchOperatorRuns(isShowingArchived) });
  const [error, setError] = useState<string | null>(null);
  const toggleArchive = async (runId: string) => {
    setError(null);
    try { await setOperatorRunArchived(runId, !isShowingArchived); invalidateRunLists(client); }
    catch (cause) { setError(String(cause)); }
  };
  return <main className="or-page" data-testid="or-run-list">
    <header className="or-page-header"><h1 className="or-page-title">{isShowingArchived ? "Archived runs" : "Runs"}</h1>
      <Button onClick={onNewRun}>Launch run</Button><Button variant="secondary" onClick={onProjects}>Projects</Button>
      <Button variant="secondary" onClick={onDefinitions}>Definitions</Button>
      <Button variant="secondary" onClick={() => setIsShowingArchived(!isShowingArchived)}>{isShowingArchived ? "Show active" : "Show archived"}</Button></header>
    {(runs.isError || error) && <p role="alert">{error ?? String(runs.error)}</p>}
    {!runs.data && !runs.isError && <p role="status">Loading runs…</p>}
    {runs.data?.length === 0 && <p>{isShowingArchived ? "No archived runs." : "No runs yet."}</p>}
    <ul>{runs.data?.map((run) => <li key={run.run_id}>
      <Button variant="secondary" onClick={() => onSelectRun(run.run_id)}>{run.run_id}</Button>
      <span> {new Date(run.created_at).toLocaleString()}</span>
      <span> {run.scopes.filter((scope) => scope.is_terminal).length}/{run.scopes.length} scopes complete</span>{" "}
      <Button variant="secondary" onClick={() => void toggleArchive(run.run_id)}>{isShowingArchived ? "Unarchive" : "Archive"}</Button>
    </li>)}</ul>
  </main>;
}
