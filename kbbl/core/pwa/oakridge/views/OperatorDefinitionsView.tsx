import { queryKeys } from "../queryKeys";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorDefinitions, setOperatorDefinitionArchived } from "../client";
import { Button } from "../../components/atoms/Button";
import { invalidateDefinitions } from "../lib/operator-invalidation";
interface Props { readonly onBack: () => void; readonly onNew: () => void; readonly onClone: (id: string) => void }
export function OperatorDefinitionsView({ onBack, onNew, onClone }: Props) {
  const client = useQueryClient();
  const [isShowingArchived, setIsShowingArchived] = useState(false);
  const definitions = useQuery({ queryKey: queryKeys.definitionList(isShowingArchived), queryFn: () => fetchOperatorDefinitions(isShowingArchived) });
  const [error, setError] = useState<string | null>(null);
  const toggleArchive = async (bundleId: string) => {
    setError(null);
    try { await setOperatorDefinitionArchived(bundleId, !isShowingArchived); invalidateDefinitions(client); }
    catch (cause) { setError(String(cause)); }
  };
  return <main className="or-page"><header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button>
    <h1 className="or-page-title">{isShowingArchived ? "Archived definitions" : "Pinned definitions"}</h1><Button onClick={onNew}>New definition</Button>
    <Button variant="secondary" onClick={() => setIsShowingArchived(!isShowingArchived)}>{isShowingArchived ? "Show active" : "Show archived"}</Button></header>
    {(definitions.isError || error) && <p role="alert">{error ?? String(definitions.error)}</p>}
    {definitions.data?.length === 0 && <p>{isShowingArchived ? "No archived definitions." : "No pinned definitions."}</p>}
    <ul>{definitions.data?.map((item) => <li key={item.digest}>{item.source.key} v{item.source.version} · <code>{item.digest}</code>{" "}
      <Button variant="secondary" onClick={() => onClone(item.bundle_id)}>Clone JSON</Button>{" "}
      <Button variant="secondary" onClick={() => void toggleArchive(item.bundle_id)}>{isShowingArchived ? "Unarchive" : "Archive"}</Button></li>)}</ul>
  </main>;
}
