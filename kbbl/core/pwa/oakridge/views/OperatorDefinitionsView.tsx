import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitions } from "../client";
import { Button } from "../../components/atoms/Button";
interface Props { readonly onBack: () => void; readonly onNew: () => void; readonly onClone: (id: string) => void }
export function OperatorDefinitionsView({ onBack, onNew, onClone }: Props) {
  const definitions = useQuery({ queryKey: queryKeys.definitions, queryFn: fetchOperatorDefinitions });
  return <main className="or-page"><header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Pinned definitions</h1><Button onClick={onNew}>New definition</Button></header>
    {definitions.isError && <p role="alert">{String(definitions.error)}</p>}
    {definitions.data?.length === 0 && <p>No pinned definitions.</p>}
    <ul>{definitions.data?.map((item) => <li key={item.digest}>{item.source.key} v{item.source.version} · <code>{item.digest}</code> <Button variant="secondary" onClick={() => onClone(item.bundle_id)}>Clone JSON</Button></li>)}</ul>
  </main>;
}
