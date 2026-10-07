import dagre from "dagre";
import type { CohortId } from "../types";
import type { PlanCohort } from "./plan";

export const PLAN_GRAPH_NODE = { width: 240, height: 92 } as const;
const RANK_GAP = 48;
const NODE_GAP = 24;
const MARGIN = 4;

export interface PlanGraphNode {
  cohort: PlanCohort;
  /** Top-left corner, in graph pixels. */
  x: number;
  y: number;
}

export interface PlanGraphEdge {
  from: CohortId;
  to: CohortId;
  /** SVG path data from the dependency to its dependent. */
  path: string;
}

/** A fixed, 1:1 layout of the whole cohort graph: no pan or zoom needed to see every cohort. */
export interface PlanGraphLayout {
  width: number;
  height: number;
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
}

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

export function selectPlanGraphLayout(cohorts: PlanCohort[]): PlanGraphLayout {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: MARGIN, marginy: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(cohorts.map((cohort) => cohort.id));
  for (const cohort of cohorts) graph.setNode(cohort.id, { ...PLAN_GRAPH_NODE });
  // A dependency on a cohort the plan does not contain would make dagre invent a node.
  const dependencies = cohorts.flatMap((cohort) =>
    [...new Set(cohort.depends_on)].filter((from) => ids.has(from)).map((from) => ({ from, to: cohort.id })));
  for (const { from, to } of dependencies) graph.setEdge(from, to);

  dagre.layout(graph);

  const { width = 0, height = 0 } = graph.graph();
  return {
    width,
    height,
    nodes: cohorts.map((cohort) => {
      const { x, y } = graph.node(cohort.id);
      return { cohort, x: x - PLAN_GRAPH_NODE.width / 2, y: y - PLAN_GRAPH_NODE.height / 2 };
    }),
    edges: dependencies.map(({ from, to }) => ({ from, to, path: selectEdgePath(graph.edge(from, to).points) })),
  };
}
