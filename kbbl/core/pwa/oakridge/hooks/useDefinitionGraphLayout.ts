import { useEffect, useState } from "react";
import {
  layout,
  validateState,
  type LaidOutDiagram,
  type StateFrame,
} from "@rankonelabs/livid-core";
import type { DefinitionGraphModel, GraphScope } from "../lib/definition-graph";
import {
  definitionRegistry,
  validateLividDefinitionDiagram,
} from "../lib/livid-graph-adapter";

type DefinitionGraphLayout =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      diagram: LaidOutDiagram<typeof definitionRegistry>;
      frame: StateFrame;
    };
interface LayoutSnapshot {
  model: DefinitionGraphModel;
  scope: GraphScope;
  result: DefinitionGraphLayout;
}
export function useDefinitionGraphLayout(
  model: DefinitionGraphModel,
  scope: GraphScope,
): DefinitionGraphLayout {
  const [snapshot, setSnapshot] = useState<LayoutSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const publish = (result: DefinitionGraphLayout) => {
      if (!cancelled) setSnapshot({ model, scope, result });
    };
    const valid = validateLividDefinitionDiagram(model, scope);
    if (!valid.ok) {
      publish({ kind: "error", message: JSON.stringify(valid.error) });
      return;
    }
    const frame = validateState(definitionRegistry, valid.value, {
      nodes: {},
      edges: {},
    });
    if (!frame.ok) {
      publish({ kind: "error", message: JSON.stringify(frame.error) });
      return;
    }
    layout(valid.value)
      .then((result) =>
        publish(
          result.ok
            ? { kind: "ready", diagram: result.value, frame: frame.value }
            : { kind: "error", message: JSON.stringify(result.error) },
        ),
      )
      .catch((cause) => publish({ kind: "error", message: String(cause) }));
    return () => {
      cancelled = true;
    };
  }, [model, scope]);
  return snapshot?.model === model && snapshot.scope === scope
    ? snapshot.result
    : { kind: "loading" };
}
