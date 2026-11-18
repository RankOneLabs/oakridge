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

export interface ParallelOrderError { readonly operation: "parallel_order"; readonly kind: "cycle" | "unknown_dependency" | "duplicate_id"; readonly cohort_ids: readonly string[] }
/** Kahn layering: only dependencies determine waves; ties preserve plan order. */
export function selectParallelWaves(plan: import("./current-contract").CurrentPlan): import("../../lib/result").Result<readonly (readonly import("./current-contract").CurrentCohort[])[], ParallelOrderError> {
  const ids = new Set(plan.cohorts.map((cohort) => cohort.id));
  if (ids.size !== plan.cohorts.length) return { ok: false, error: { operation: "parallel_order", kind: "duplicate_id", cohort_ids: plan.cohorts.map((cohort) => cohort.id) } };
  const unknown = plan.cohorts.flatMap((cohort) => cohort.depends_on.filter((id) => !ids.has(id)));
  if (unknown.length) return { ok: false, error: { operation: "parallel_order", kind: "unknown_dependency", cohort_ids: unknown } };
  const done = new Set<string>();
  const waves: import("./current-contract").CurrentCohort[][] = [];
  while (done.size < plan.cohorts.length) {
    const wave = plan.cohorts.filter((cohort) => !done.has(cohort.id) && cohort.depends_on.every((id) => done.has(id)));
    if (!wave.length) return { ok: false, error: { operation: "parallel_order", kind: "cycle", cohort_ids: plan.cohorts.filter((cohort) => !done.has(cohort.id)).map((cohort) => cohort.id) } };
    waves.push(wave);
    wave.forEach((cohort) => done.add(cohort.id));
  }
  return { ok: true, value: waves };
}
