import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { Button } from "../../../components/atoms/Button";

interface WorkflowDefDetailProps {
  definitionId: string;
  onBack: () => void;
  onClone: () => void;
}

export function WorkflowDefDetail({
  definitionId,
  onBack,
  onClone,
}: WorkflowDefDetailProps) {
  const query = useWorkflowDef(definitionId);

  if (query.isPending) {
    return <div className="or-loading" data-testid="or-def-detail-loading">Loading definition…</div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="or-error" role="alert" data-testid="or-def-detail-error">
        {query.error instanceof Error ? query.error.message : "Failed to load definition"}
      </div>
    );
  }

  const definition = query.data;
  return (
    <div className="or-def-detail" data-testid="or-def-detail">
      <header className="or-def-detail__header">
        <div>
          <Button variant="secondary" onClick={onBack}>← Workflows</Button>
          <h2>{definition.name} <span>v{definition.version}</span></h2>
          <p>ID: <code>{definition.id}</code> · Created {new Date(definition.created_at).toLocaleString()}</p>
        </div>
        <Button variant="secondary" onClick={onClone}>
          Clone to new version
        </Button>
      </header>

      <ul className="flex flex-col gap-3">{definition.definition.scopes.map((scope) => <li key={scope.key} data-testid="or-def-stage">
        <h3>{scope.key}</h3><p>Children: {scope.children.map((child) => child.key).join(", ") || "none"}</p>
        <p>Workers: {scope.workers.map((worker) => worker.key).join(", ")}</p>
      </li>)}</ul>

      <details className="or-def-detail__raw">
        <summary>Raw definition JSON</summary>
        <pre>{JSON.stringify(definition.definition, null, 2)}</pre>
      </details>
    </div>
  );
}
