import { useWorkflowDef } from "./hooks";
import type { EdgeDef, StageNodeDef } from "./types";

interface WorkflowDefDetailViewProps {
  definitionId: string;
  onBack: () => void;
  onClone: () => void;
}

interface StageCardProps {
  stageKey: string;
  stage: StageNodeDef;
}

function SlotList({ label, slots }: { label: string; slots: StageNodeDef["inputs"] | StageNodeDef["outputs"] }) {
  return (
    <div className="or-def-stage__slots">
      <span className="or-def-stage__slot-label">{label}</span>
      {slots.length === 0 ? (
        <span className="or-def-stage__empty">none</span>
      ) : (
        slots.map((slot) => (
          <span className="or-def-stage__slot" key={`${slot.name}:${slot.artifact_type}`}>
            {slot.name} <small>{slot.artifact_type}</small>
          </span>
        ))
      )}
    </div>
  );
}

function StageCard({ stageKey, stage }: StageCardProps) {
  return (
    <article className="or-def-stage" data-testid="or-def-stage">
      <header className="or-def-stage__header">
        <h3>{stageKey}</h3>
        <span className="or-badge">{stage.stage_type}</span>
      </header>
      <SlotList label="Inputs" slots={stage.inputs} />
      <SlotList label="Outputs" slots={stage.outputs} />
      <details className="or-def-stage__config">
        <summary>Stage configuration</summary>
        <pre>{JSON.stringify(stage.config, null, 2)}</pre>
      </details>
    </article>
  );
}

function EdgeList({ edges }: { edges: EdgeDef[] }) {
  return (
    <section className="or-def-edges" aria-label="Workflow connections">
      <h3>Connections</h3>
      {edges.length === 0 ? (
        <p className="or-def-detail__muted">No connections.</p>
      ) : (
        <ol>
          {edges.map((edge, index) => (
            <li key={`${edge.from.stage}:${edge.from.slot}:${edge.to.stage}:${edge.to.slot}:${index}`}>
              <code>{edge.from.stage}.{edge.from.slot}</code>
              <span aria-hidden="true">→</span>
              <code>{edge.to.stage}.{edge.to.slot}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WorkflowDefDetailView({
  definitionId,
  onBack,
  onClone,
}: WorkflowDefDetailViewProps) {
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
  const stages = Object.entries(definition.graph.stages);

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

      <section className="or-def-detail__graph" aria-label="Workflow stages">
        <h3>Stages</h3>
        <div className="or-def-detail__stages">
          {stages.map(([stageKey, stage]) => (
            <StageCard key={stageKey} stageKey={stageKey} stage={stage} />
          ))}
        </div>
      </section>
      <EdgeList edges={definition.graph.edges} />

      <details className="or-def-detail__raw">
        <summary>Raw definition JSON</summary>
        <pre>{JSON.stringify(definition.graph, null, 2)}</pre>
      </details>
    </div>
  );
}
