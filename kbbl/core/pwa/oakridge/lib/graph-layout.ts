import type { DefinitionGraphModel } from "./definition-graph";
import dagre from "dagre";

export interface GraphLayoutNode<Id extends string> {
  id: Id;
  width: number;
  height: number;
}
export interface GraphLayoutEdge<Id extends string> {
  from: Id;
  to: Id;
}
export interface GraphLayoutInput<Id extends string> {
  nodes: readonly GraphLayoutNode<Id>[];
  edges: readonly GraphLayoutEdge<Id>[];
}
export interface PositionedGraphNode<
  Id extends string,
> extends GraphLayoutNode<Id> {
  x: number;
  y: number;
}
export interface PositionedGraphEdge<
  Id extends string,
> extends GraphLayoutEdge<Id> {
  path: string;
}
export interface GraphLayout<Id extends string> {
  width: number;
  height: number;
  nodes: PositionedGraphNode<Id>[];
  edges: PositionedGraphEdge<Id>[];
}
const RANK_GAP = 48;
const NODE_GAP = 24;
const MARGIN = 4;

interface Point {
  x: number;
  y: number;
}

/** Straight first and last legs with smooth bends between, so arrowheads meet nodes square-on. */
function selectEdgePath(points: Point[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return "";
  const bends = points.slice(1, -1);
  const curves = bends.map((bend, index) => {
    const next = bends[index + 1] ?? last;
    return ` Q${bend.x},${bend.y} ${(bend.x + next.x) / 2},${(bend.y + next.y) / 2}`;
  });
  return `M${first.x},${first.y}${curves.join("")} L${last.x},${last.y}`;
}

export function selectGraphLayout<Id extends string>(
  input: GraphLayoutInput<Id>,
): GraphLayout<Id> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    ranksep: RANK_GAP,
    nodesep: NODE_GAP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(input.nodes.map((node) => node.id));
  for (const node of input.nodes)
    graph.setNode(node.id, { width: node.width, height: node.height });
  const seen = new Set<string>();
  const edges = input.edges.filter(({ from, to }) => {
    const pair = JSON.stringify([from, to]);
    if (!ids.has(from) || !ids.has(to) || seen.has(pair)) return false;
    seen.add(pair);
    return true;
  });
  for (const { from, to } of edges) graph.setEdge(from, to);
  dagre.layout(graph);
  const { width = 0, height = 0 } = graph.graph();
  return {
    width,
    height,
    nodes: input.nodes.map((node) => {
      const { x, y } = graph.node(node.id);
      return { ...node, x: x - node.width / 2, y: y - node.height / 2 };
    }),
    edges: edges.map(({ from, to }) => ({
      from,
      to,
      path: selectEdgePath(graph.edge(from, to).points),
    })),
  };
}

import type { DefinitionSelection } from "../../lib/hash";
import type {
  DefinitionOverview,
  DefinitionUnitOverview,
} from "./definition-overview";
import type {
  DefinitionDependencies,
  DependencyEdge,
} from "./definition-dependencies";

interface DefinitionGraphInput {
  model?: DefinitionGraphModel;
  overview: DefinitionOverview;
  dependencies: DefinitionDependencies;
  selection: DefinitionSelection | null;
}
interface DefinitionGraphBreadcrumb {
  name: string;
  path: string;
}
export type DefinitionGraphEdge = DependencyEdge & { offset_x: number };

/** Parallel kinds must remain visibly distinct even though Dagre routes one path per pair. */
function selectGraphEdges(edges: DependencyEdge[]): DefinitionGraphEdge[] {
  const kinds = new Map<string, Set<DependencyEdge["kind"]>>();
  for (const edge of edges) {
    const pair = JSON.stringify([edge.from, edge.to]);
    const pair_kinds = kinds.get(pair) ?? new Set<DependencyEdge["kind"]>();
    pair_kinds.add(edge.kind);
    kinds.set(pair, pair_kinds);
  }
  return edges.map((edge) => ({
    ...edge,
    offset_x:
      (kinds.get(JSON.stringify([edge.from, edge.to]))?.size ?? 0) > 1
        ? edge.kind === "explicit"
          ? -6
          : 6
        : 0,
  }));
}

export interface DefinitionGraphLayoutView {
  units: DefinitionUnitOverview[];
  edges: DefinitionGraphEdge[];
  layout: GraphLayout<string>;
  breadcrumbs: DefinitionGraphBreadcrumb[];
}

export function selectDefinitionGraph({
  overview,
  model,
  dependencies,
  selection,
}: DefinitionGraphInput): DefinitionGraphLayoutView {
  const selected =
    selection?.kind === "unit"
      ? overview.units.find((unit) => unit.path === selection.path)
      : null;
  const parent = selected?.is_group
    ? selected.path
    : (selected?.parent ?? null);
  const units = overview.units.filter((unit) => unit.parent === parent);
  const ids = new Set(units.map((unit) => unit.path));
  const projected: DependencyEdge[] = model
    ? model.edges.flatMap((edge): DependencyEdge[] => {
        const from = model.nodes.find((node) => node.id === edge.from);
        const to = model.nodes.find((node) => node.id === edge.to);
        if (from?.kind !== "unit" || to?.kind !== "unit") return [];
        if (edge.kind === "dependency")
          return [{ kind: "explicit", from: from.path, to: to.path }];
        if (edge.kind !== "binding") return [];
        return [
          {
            kind: "referenced",
            from: from.path,
            to: to.path,
            references: [
              {
                upstream: from.path,
                downstream: to.path,
                binding: edge.label.binding,
                outcome_path: edge.label.outcome_path,
              },
            ],
          },
        ];
      })
    : dependencies.edges;
  const merged = new Map<string, DependencyEdge>();
  for (const edge of projected) {
    const key = JSON.stringify([edge.kind, edge.from, edge.to]);
    const previous = merged.get(key);
    merged.set(
      key,
      edge.kind === "referenced" && previous?.kind === "referenced"
        ? { ...edge, references: [...previous.references, ...edge.references] }
        : edge,
    );
  }
  const edges = selectGraphEdges(
    [...merged.values()].filter(
      (edge) => ids.has(edge.from) && ids.has(edge.to),
    ),
  );
  const layout = selectGraphLayout({
    nodes: units.map((unit) => ({
      id: unit.path,
      width: DEFINITION_NODE_WIDTH,
      height: DEFINITION_NODE_HEIGHT,
    })),
    edges,
  });
  const breadcrumbs = (parent?.split("/") ?? []).map((name, index, parts) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }));
  return { units, edges, layout, breadcrumbs };
}

export const DEFINITION_NODE_WIDTH = 240;
export const DEFINITION_NODE_HEIGHT = 100;
export function selectDefinitionNodeLabel(text: string): string {
  return text.length > 28 ? text.slice(0, 27) + "…" : text;
}
export function selectDefinitionNodeSelected(
  unit: DefinitionUnitOverview,
  selection: DefinitionSelection | null,
): boolean {
  return selection?.kind === "unit"
    ? selection.path === unit.path
    : selection?.kind === "stage" && selection.stage === unit.stage;
}
