import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorDefinitions, setOperatorDefinitionArchived } from "../client";
import { queryKeys } from "../queryKeys";
import { invalidateDefinitions } from "../lib/operator-invalidation";
import { WorkflowDefList } from "../components/organisms/WorkflowDefList";
import { Button } from "../../components/atoms/Button";

interface Props { readonly onBack: () => void; readonly onNew: () => void; readonly onSelect: (id: string) => void; readonly onClone: (id: string) => void }
export function WorkflowDefListView({ onBack, onNew, onSelect, onClone }: Props) {
  const client = useQueryClient();
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: queryKeys.definitionList(isArchived), queryFn: () => fetchOperatorDefinitions(isArchived) });
  const toggleArchived = async (id: string) => {
    setError(null);
    try { await setOperatorDefinitionArchived(id, !isArchived); invalidateDefinitions(client); }
    catch (cause) { setError(String(cause)); }
  };
  return <main className="or-page"><header className="or-page-header">
    <Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">{isArchived ? "Archived definitions" : "Pinned definitions"}</h1>
    <Button onClick={onNew}>New definition</Button><Button variant="secondary" onClick={() => setIsArchived((value) => !value)}>{isArchived ? "Show active" : "Show archived"}</Button>
  </header>
    {(query.error || error) && <p role="alert">{error ?? String(query.error)}</p>}
    {query.isPending && <p role="status">Loading definitions…</p>}
    {query.data?.length === 0 && <p>No {isArchived ? "archived" : "pinned"} definitions.</p>}
    {query.data && <WorkflowDefList definitions={query.data} isArchived={isArchived} onSelect={onSelect} onClone={onClone}
      onArchive={(id) => void toggleArchived(id)} />}
  </main>;
}
