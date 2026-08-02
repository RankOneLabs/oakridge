import type { EdgeDef, StageNodeDef, WorkflowGraph as WorkflowGraphModel } from "../../types";

function SlotList({ label, slots }: { label: string; slots: StageNodeDef["inputs"] | StageNodeDef["outputs"] }) {
  return (
    <div className="or-def-stage__slots">
      <span className="or-def-stage__slot-label">{label}</span>
      {slots.length === 0
        ? <span className="or-def-stage__empty">none</span>
        : slots.map((slot) => (
          <span className="or-def-stage__slot" key={`${slot.name}:${slot.artifact_type}`}>
            {slot.name} <small>{slot.artifact_type}</small>
          </span>
        ))}
    </div>
  );
}

function StageCard({ stageKey, stage }: { stageKey: string; stage: StageNodeDef }) {
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

function WorkflowEdges({ edges }: { edges: EdgeDef[] }) {
  return (
    <section className="or-def-edges" aria-label="Workflow connections">
      <h3>Connections</h3>
      {edges.length === 0
        ? <p className="or-def-detail__muted">No connections.</p>
        : (
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

export function WorkflowGraph({ graph }: { graph: WorkflowGraphModel }) {
  return (
    <>
      <section className="or-def-detail__graph" aria-label="Workflow stages">
        <h3>Stages</h3>
        <div className="or-def-detail__stages">
          {Object.entries(graph.stages).map(([stageKey, stage]) => (
            <StageCard key={stageKey} stageKey={stageKey} stage={stage} />
          ))}
        </div>
      </section>
      <WorkflowEdges edges={graph.edges} />
    </>
  );
}
