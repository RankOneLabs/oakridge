import { useMemo } from "react";
import type { DefinitionSelection } from "../../../lib/hash";
import type { DefinitionGraphModel } from "../../lib/definition-graph";
import {
  selectDefinitionGraphNodeHref,
  selectDefinitionGraphRoute,
} from "../../lib/livid-graph-adapter";
import { useDefinitionGraphLayout } from "../../hooks/useDefinitionGraphLayout";
import { LividDefinitionGraph } from "../molecules/LividDefinitionGraph";
interface LividDefinitionGraphControllerProps {
  model: DefinitionGraphModel;
  selection: DefinitionSelection | null;
  definition_id: string;
}
export function LividDefinitionGraphController({
  model,
  selection,
  definition_id,
}: LividDefinitionGraphControllerProps) {
  const kind = selection?.kind;
  const key = selection?.kind === "stage" ? selection.stage : selection?.path;
  const route = useMemo(
    () =>
      selectDefinitionGraphRoute(
        model,
        kind === "stage" && key
          ? { kind, stage: key }
          : kind === "unit" && key
            ? { kind, path: key }
            : null,
      ),
    [model, kind, key],
  );
  const result = useDefinitionGraphLayout(model, route.scope);
  if (result.kind === "error") return <p role="alert">{result.message}</p>;
  if (result.kind === "loading")
    return <p role="status">Laying out definition…</p>;
  const selected = result.diagram.nodes.find(
    ({ node }) => node.id === route.selected_node?.id,
  )?.node;
  const navigate = (node_id: string, descend: boolean) => {
    const href = selectDefinitionGraphNodeHref({
      model,
      definition_id,
      node_id,
      descend,
    });
    if (href) window.location.hash = href;
  };
  return (
    <LividDefinitionGraph
      diagram={result.diagram}
      frame={result.frame}
      ariaLabel="Definition graph"
      selection={
        selected
          ? { kind: "node", id: selected.id, detail: selected.detail }
          : null
      }
      onSelectionChange={(value) => {
        if (value?.kind === "node") navigate(value.id, false);
      }}
      onDescendRequest={({ nodeId }) => navigate(nodeId, true)}
    />
  );
}
