// kbbl rule 5: library CSS belongs beside the component consuming the library.
import "@xyflow/react/dist/style.css";
import "@rankonelabs/livid-react/styles.css";
import { LividDiagram, type DiagramSelection } from "@rankonelabs/livid-react";
import {
  layout,
  validateState,
  type LaidOutDiagram,
} from "@rankonelabs/livid-core";
import { useEffect, useState } from "react";
import type {
  DefinitionGraphModel,
  GraphScope,
} from "../../lib/definition-graph";
import {
  definitionRegistry,
  validateLividDefinitionDiagram,
} from "../../lib/livid-graph-adapter";
import {
  definitionStageHref,
  definitionUnitHref,
} from "../../lib/definition-selection";
interface LividDefinitionGraphProps {
  model: DefinitionGraphModel;
  scope: GraphScope;
  definition_id: string;
}
export function LividDefinitionGraph({
  model,
  scope,
  definition_id,
}: LividDefinitionGraphProps) {
  const [diagram, setDiagram] = useState<LaidOutDiagram<
    typeof definitionRegistry
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiagramSelection | null>(null);
  const [activeScope, setActiveScope] = useState(scope);
  useEffect(() => {
    setActiveScope(scope);
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    setDiagram(null);
    setError(null);
    const valid = validateLividDefinitionDiagram(model, activeScope);
    if (!valid.ok) {
      setError(JSON.stringify(valid.error));
      return;
    }
    layout(valid.value)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDiagram(result.value);
        else setError(JSON.stringify(result.error));
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [model, activeScope]);
  if (error) return <p role="alert">{error}</p>;
  if (!diagram) return <p role="status">Laying out definition…</p>;
  const valid = validateLividDefinitionDiagram(model, activeScope);
  if (!valid.ok) return null;
  const frame = validateState(definitionRegistry, valid.value, {
    nodes: {},
    edges: {},
  });
  if (!frame.ok) return null;
  return (
    <div className="h-[600px]">
      <LividDiagram
        diagram={diagram}
        frame={frame.value}
        ariaLabel="Definition graph"
        selection={selection}
        onSelectionChange={(value) => {
          setSelection(value);
          const node =
            value?.kind === "node"
              ? model.nodes.find((node) => node.id === value.id)
              : null;
          if (node?.kind === "unit")
            window.location.hash = definitionUnitHref(definition_id, node.path);
          if (node?.kind === "stage")
            window.location.hash = definitionStageHref(
              definition_id,
              node.stage,
            );
        }}
        onDescendRequest={({ nodeId }) => {
          const node = model.nodes.find((node) => node.id === nodeId);
          if (node?.kind === "unit" && node.is_group)
            setActiveScope({ kind: "group", parent: node.path });
          else if (node?.kind === "unit" && node.stage)
            setActiveScope({ kind: "stage", stage: node.stage });
        }}
      />
    </div>
  );
}
