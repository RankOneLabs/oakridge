import { selectGraphLayout } from "./graph-layout";

export const PLAN_GRAPH_NODE = { width: 240, height: 92 } as const;

/** What the cohort graph draws of a cohort, legacy or current: its id, title and dependencies. */
export interface PlanGraphCohort<Id extends string = string> {
  readonly id: Id;
  readonly title: string;
  readonly depends_on: readonly Id[];
}

export interface PlanGraphNode<C extends PlanGraphCohort> {
  cohort: C;
  /** Top-left corner, in graph pixels. */
  x: number;
  y: number;
}

export interface PlanGraphEdge<Id extends string> {
  from: Id;
  to: Id;
  /** SVG path data from the dependency to its dependent. */
  path: string;
}

/** A fixed, 1:1 layout of the whole cohort graph: no pan or zoom needed to see every cohort. */
export interface PlanGraphLayout<C extends PlanGraphCohort> {
  width: number;
  height: number;
  nodes: PlanGraphNode<C>[];
  edges: PlanGraphEdge<C["id"]>[];
}

export function selectPlanGraphLayout<C extends PlanGraphCohort>(cohorts: readonly C[]): PlanGraphLayout<C> {
  const layout = selectGraphLayout<C["id"]>({
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
export function selectParallelWaves(plan: import("./viewer-data").CurrentPlan): import("../../lib/result").Result<readonly (readonly import("./viewer-data").CurrentCohort[])[], ParallelOrderError> {
  const ids = new Set(plan.cohorts.map((cohort) => cohort.id));
  if (ids.size !== plan.cohorts.length) return { ok: false, error: { operation: "parallel_order", kind: "duplicate_id", cohort_ids: plan.cohorts.map((cohort) => cohort.id) } };
  const unknown = plan.cohorts.flatMap((cohort) => cohort.depends_on.filter((id) => !ids.has(id)));
  if (unknown.length) return { ok: false, error: { operation: "parallel_order", kind: "unknown_dependency", cohort_ids: unknown } };
  const done = new Set<string>();
  const waves: import("./viewer-data").CurrentCohort[][] = [];
  while (done.size < plan.cohorts.length) {
    const wave = plan.cohorts.filter((cohort) => !done.has(cohort.id) && cohort.depends_on.every((id) => done.has(id)));
    if (!wave.length) return { ok: false, error: { operation: "parallel_order", kind: "cycle", cohort_ids: plan.cohorts.filter((cohort) => !done.has(cohort.id)).map((cohort) => cohort.id) } };
    waves.push(wave);
    wave.forEach((cohort) => done.add(cohort.id));
  }
  return { ok: true, value: waves };
}

export interface ParallelCohortRow { readonly cohort: import("./viewer-data").CurrentCohort; readonly cohort_index: number; readonly wave_number: number | null }
export interface ParallelPlanView { readonly rows: readonly ParallelCohortRow[]; readonly error: ParallelOrderError | null }
export function selectParallelCohortRows(plan: import("./viewer-data").CurrentPlan): ParallelPlanView {
  const waves = selectParallelWaves(plan);
  const waveNumbers = new Map(waves.ok ? waves.value.flatMap((wave, index) => wave.map((cohort) => [cohort.id, index + 1] as const)) : []);
  return { error: waves.ok ? null : waves.error,
    rows: plan.cohorts.map((cohort, cohort_index) => ({ cohort, cohort_index, wave_number: waveNumbers.get(cohort.id) ?? null })),
  };
}
