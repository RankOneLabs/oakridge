import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { Button } from "../../../components/atoms/Button";

interface WorkflowDefDetailProps { readonly definitionId: string; readonly onBack: () => void }
export function WorkflowDefDetail({ definitionId, onBack }: WorkflowDefDetailProps) {
  const query = useWorkflowDef(definitionId);
  if (query.isPending) return <div data-testid="or-def-detail-loading">Loading definition…</div>;
  if (query.isError || !query.data) return <div role="alert" data-testid="or-def-detail-error">{query.error?.message ?? "Definition unavailable"}</div>;
  const definition = query.data;
  return <div className="or-page or-page--wide" data-testid="or-def-detail">
    <Button variant="secondary" onClick={onBack}>← Workflows</Button>
    <h2>{definition.bundle.key}</h2>
    <p>Definition ID: <code>{definition.definition_id}</code></p>
    <h3>Schemas</h3>
    <ul>{definition.bundle.schemas.map((schema) => <li key={schema.key}>{schema.key}</li>)}</ul>
    <h3>Stages</h3>
    <ul>{definition.bundle.stages.map((stage) => <li key={stage}>{stage}</li>)}</ul>
    <h3>Units</h3>
    <ul>{definition.bundle.units.map((unit) => <li key={unit.key}>{unit.label}{unit.stage ? ` · ${unit.stage}` : ""}</li>)}</ul>
    <details><summary>Committed definition JSON</summary><pre>{JSON.stringify(definition.workflow, null, 2)}</pre></details>
  </div>;
}
