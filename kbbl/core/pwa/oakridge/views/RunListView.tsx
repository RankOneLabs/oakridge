import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRuns } from "../client";
import { queryKeys } from "../queryKeys";
import { useRunAttention } from "../hooks/useRunAttention";
import { selectRunAttention } from "../lib/run-attention";
import { useSetRunArchived } from "../hooks/useSetRunArchived";
import type { OperatorRunView } from "../operator-contracts";
import { ProgressRow } from "../components/molecules/ProgressRow";
import { Button } from "../../components/atoms/Button";

interface Props { readonly onSelectRun: (id: string) => void; readonly onNewRun: () => void; readonly onDefinitions: () => void; readonly onProjects: () => void }
export function RunListView({ onSelectRun, onNewRun, onDefinitions, onProjects }: Props) {
  const archive = useSetRunArchived();
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = useQuery({ queryKey: queryKeys.runList(isArchived), queryFn: () => fetchOperatorRuns(isArchived) });
  const toggleArchived = async (id: string) => {
    setError(null);
    try { await archive.mutateAsync({ runId: id, isArchived: !isArchived }); }
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
    <ul>{runs.data?.map((run) => <RunListItem key={run.run_id} run={run} isArchived={isArchived}
      onSelectRun={onSelectRun} onToggleArchived={toggleArchived} />)}</ul>
  </main>;
}

function RunListItem({ run, isArchived, onSelectRun, onToggleArchived }: {
  readonly run: OperatorRunView; readonly isArchived: boolean; readonly onSelectRun: (id: string) => void;
  readonly onToggleArchived: (id: string) => Promise<void>;
}) {
  const attention = useRunAttention(run.run_id);
  return <li className="flex items-center gap-3">
    <ProgressRow run={run} attentionCount={selectRunAttention(attention.data?.items ?? []).count} onSelectRun={onSelectRun} />
    <Button variant="secondary" onClick={() => void onToggleArchived(run.run_id)}>{isArchived ? "Unarchive" : "Archive"}</Button>
  </li>;
}
