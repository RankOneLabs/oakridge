import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { WorkflowGraph } from "../molecules/WorkflowGraph";

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
          <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Workflows</button>
          <h2>{definition.name} <span>v{definition.version}</span></h2>
          <p>ID: <code>{definition.id}</code> · Created {new Date(definition.created_at).toLocaleString()}</p>
        </div>
        <button type="button" className="or-btn or-btn--secondary" onClick={onClone}>
          Clone to new version
        </button>
      </header>

      <WorkflowGraph graph={definition.graph} />

      <details className="or-def-detail__raw">
        <summary>Raw definition JSON</summary>
        <pre>{JSON.stringify(definition.graph, null, 2)}</pre>
      </details>
    </div>
  );
}
