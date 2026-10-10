import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitions } from "../client";
import { queryKeys } from "../queryKeys";
import { selectDefinitionSummary } from "../lib/workflow-definition-form";
import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";
import { Button } from "../../components/atoms/Button";

interface Props { readonly definitionId: string; readonly onBack: () => void; readonly onClone: () => void }
export function WorkflowDefDetailView({ definitionId, onBack, onClone }: Props) {
  const query = useQuery({ queryKey: queryKeys.definitionList(false), queryFn: () => fetchOperatorDefinitions(false) });
  const archived = useQuery({ queryKey: queryKeys.definitionList(true), queryFn: () => fetchOperatorDefinitions(true) });
  const definition = selectDefinitionSummary(query.data, archived.data, definitionId);
  return <main className="or-page" data-testid="or-def-detail-view"><Button variant="secondary" onClick={onBack}>Back</Button>
    {(query.isPending || archived.isPending) && <p role="status">Loading definition…</p>}
    {(query.isError || archived.isError) && <p role="alert">{String(query.error ?? archived.error)}</p>}
    {query.isSuccess && archived.isSuccess && !definition && <p role="alert">Definition not found.</p>}
    {definition && <WorkflowDefDetail definition={definition} onClone={onClone} />}
  </main>;
}
