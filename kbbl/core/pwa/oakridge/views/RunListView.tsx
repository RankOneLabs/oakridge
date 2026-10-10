import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorRuns, setOperatorRunArchived } from "../client";
import { queryKeys } from "../queryKeys";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { selectRunAttentionCounts } from "../lib/run-attention";
import { invalidateRunLists } from "../lib/operator-invalidation";
import { ProgressRow } from "../components/molecules/ProgressRow";
import { Button } from "../../components/atoms/Button";

interface Props { readonly onSelectRun: (id: string) => void; readonly onNewRun: () => void; readonly onDefinitions: () => void; readonly onProjects: () => void }
export function RunListView({ onSelectRun, onNewRun, onDefinitions, onProjects }: Props) {
  const client = useQueryClient();
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = useQuery({ queryKey: queryKeys.runList(isArchived), queryFn: () => fetchOperatorRuns(isArchived) });
  const inbox = useReviewInbox();
  const attention = selectRunAttentionCounts(inbox.data?.items ?? []);
  const toggleArchived = async (id: string) => {
    setError(null);
    try { await setOperatorRunArchived(id, !isArchived); invalidateRunLists(client); }
    catch (cause) { setError(String(cause)); }
  };
  return <main className="or-page" data-testid="or-run-list"><header className="or-page-header">
    <h1 className="or-page-title">{isArchived ? "Archived runs" : "Runs"}</h1>
    <Button onClick={onNewRun}>Launch run</Button><Button variant="secondary" onClick={onProjects}>Projects</Button>
    <Button variant="secondary" onClick={onDefinitions}>Definitions</Button>
    <Button variant="secondary" onClick={() => setIsArchived((value) => !value)}>{isArchived ? "Show active" : "Show archived"}</Button>
  </header>
    {(runs.error || error) && <p role="alert">{error ?? String(runs.error)}</p>}
    {runs.isPending && <p role="status">Loading runs…</p>}
    {runs.data?.length === 0 && <p>{isArchived ? "No archived runs." : "No runs yet."}</p>}
    <ul>{runs.data?.map((run) => <li key={run.run_id} className="flex items-center gap-3">
      <ProgressRow run={run} attentionCount={attention.get(run.run_id) ?? 0} onSelectRun={onSelectRun} />
      <Button variant="secondary" onClick={() => void toggleArchived(run.run_id)}>{isArchived ? "Unarchive" : "Archive"}</Button>
    </li>)}</ul>
  </main>;
}
