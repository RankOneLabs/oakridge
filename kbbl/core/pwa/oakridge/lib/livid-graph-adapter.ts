import {
  defineRegistry,
  validateDiagram,
  type DiagramSpec,
} from "@rankonelabs/livid-core";
import { z } from "zod";
import type {
  DefinitionGraphModel,
  GraphScope,
  GraphEdge,
} from "./definition-graph";

const node = {
  label: "Definition element",
  detail: z.object({}).passthrough(),
  shape: "rounded" as const,
  isRouter: false,
};
const edge = {
  label: "Definition relationship",
  detail: z.object({}).passthrough(),
};
export const definitionRegistry = defineRegistry({
  nodeTypes: { stage: node, unit: node, artifact: node },
  edgeTypes: {
    dependency: edge,
    binding: edge,
    produces: edge,
    consumes: edge,
    revise_loop: edge,
  },
});
export function isGraphScope(left: GraphScope, right: GraphScope): boolean {
  return left.kind === "group"
    ? right.kind === "group" && left.parent === right.parent
    : right.kind === "stage" && left.stage === right.stage;
}
export function selectGraphEdgeLabel(edge: GraphEdge): string {
  switch (edge.kind) {
    case "dependency":
      return "after";
    case "binding":
      return ["outcome", ...edge.label.outcome_path].join(".");
    case "produces":
      return edge.label.worker;
    case "consumes":
      return edge.label.consumer.kind;
    case "revise_loop":
      return `${edge.label.review}: ${edge.label.decision} → ${edge.label.worker}`;
  }
}
export function selectLividDiagramSpec(
  model: DefinitionGraphModel,
  scope: GraphScope,
): DiagramSpec {
  return {
    profile: "dependency",
    nodes: model.nodes
      .filter((node) => isGraphScope(node.scope, scope))
      .map((node) => ({
        id: node.id,
        type: node.kind,
        label:
          node.kind === "unit"
            ? node.key
            : node.kind === "stage"
              ? node.stage
              : node.artifact,
        detail: node,
        ...(node.kind === "unit" && (node.is_group || node.stage_node_id)
          ? {
              childState: {
                kind: "deferred" as const,
                key: node.is_group ? node.id : (node.stage_node_id ?? node.id),
              },
            }
          : {}),
      })),
    edges: model.edges
      .filter((edge) => isGraphScope(edge.scope, scope))
      .map((edge) => ({
        id: edge.id,
        type: edge.kind,
        source: edge.from,
        target: edge.to,
        label: selectGraphEdgeLabel(edge),
        detail: edge.label,
      })),
  };
}
export function validateLividDefinitionDiagram(
  model: DefinitionGraphModel,
  scope: GraphScope,
) {
  return validateDiagram(
    definitionRegistry,
    selectLividDiagramSpec(model, scope),
    { nodeTypeLimit: 8, edgeTypeLimit: 8 },
  );
}

import type { DefinitionSelection } from "../../lib/hash";
import type { GraphNode } from "./definition-graph";
import {
  definitionStageHref,
  definitionUnitHref,
} from "./definition-selection";
export interface DefinitionGraphRoute {
  scope: GraphScope;
  selected_node: GraphNode | null;
}
export function selectDefinitionGraphRoute(
  model: DefinitionGraphModel,
  selection: DefinitionSelection | null,
): DefinitionGraphRoute {
  const node =
    model.nodes.find((node) =>
      selection?.kind === "stage"
        ? node.kind === "stage" && node.stage === selection.stage
        : selection?.kind === "unit" &&
          node.kind === "unit" &&
          node.path === selection.path,
    ) ?? null;
  return {
    scope:
      node?.kind === "stage"
        ? node.scope
        : node?.kind === "unit" && node.is_group
          ? { kind: "group", parent: node.path }
          : (node?.scope ?? { kind: "group", parent: null }),
    // A group route shows its children, so the group itself is outside the visible scope.
    selected_node: node?.kind === "unit" && node.is_group ? null : node,
  };
}
interface GraphNodeNavigation {
  model: DefinitionGraphModel;
  definition_id: string;
  node_id: string;
  descend: boolean;
}
export function selectDefinitionGraphNodeHref({
  model,
  definition_id,
  node_id,
  descend,
}: GraphNodeNavigation): string | null {
  const node = model.nodes.find((node) => node.id === node_id);
  if (node?.kind === "stage")
    return definitionStageHref(definition_id, node.stage);
  if (node?.kind !== "unit") return null;
  return descend && !node.is_group && node.stage
    ? definitionStageHref(definition_id, node.stage)
    : definitionUnitHref(definition_id, node.path);
}
