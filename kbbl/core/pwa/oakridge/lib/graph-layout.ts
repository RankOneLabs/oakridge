import dagre from "dagre";

export interface GraphLayoutNode<Id extends string> { id: Id; width: number; height: number }
export interface GraphLayoutEdge<Id extends string> { from: Id; to: Id }
export interface GraphLayoutInput<Id extends string> { nodes: readonly GraphLayoutNode<Id>[]; edges: readonly GraphLayoutEdge<Id>[] }
export interface PositionedGraphNode<Id extends string> extends GraphLayoutNode<Id> { x: number; y: number }
export interface PositionedGraphEdge<Id extends string> extends GraphLayoutEdge<Id> { path: string }
export interface GraphLayout<Id extends string> { width: number; height: number; nodes: PositionedGraphNode<Id>[]; edges: PositionedGraphEdge<Id>[] }
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

export function selectGraphLayout<Id extends string>(input: GraphLayoutInput<Id>): GraphLayout<Id> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: MARGIN, marginy: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(input.nodes.map((node) => node.id));
  for (const node of input.nodes) graph.setNode(node.id, { width: node.width, height: node.height });
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
  return { width, height, nodes: input.nodes.map((node) => {
    const { x, y } = graph.node(node.id);
    return { ...node, x: x - node.width / 2, y: y - node.height / 2 };
  }), edges: edges.map(({ from, to }) => ({ from, to, path: selectEdgePath(graph.edge(from, to).points) })) };
}
