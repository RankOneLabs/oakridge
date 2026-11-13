import { selectGraphLayout } from "./graph-layout";
import type { CohortId } from "../run-types";
import type { PlanCohort } from "./plan";

export const PLAN_GRAPH_NODE = { width: 240, height: 92 } as const;

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

export function selectPlanGraphLayout(cohorts: PlanCohort[]): PlanGraphLayout {
  const layout = selectGraphLayout({
    nodes: cohorts.map((cohort) => ({ id: cohort.id, ...PLAN_GRAPH_NODE })),
    edges: cohorts.flatMap((cohort) => cohort.depends_on.map((from) => ({ from, to: cohort.id }))),
  });
  return { ...layout, nodes: cohorts.map((cohort, index) => {
    const node = layout.nodes[index];
    return { cohort, x: node?.x ?? 0, y: node?.y ?? 0 };
  }) };
}
