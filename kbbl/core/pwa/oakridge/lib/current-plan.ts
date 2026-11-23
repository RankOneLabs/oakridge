import type { CurrentPlan } from "./viewer-data";
import type { SubnavSection } from "./artifact-subnav";

export type PlanSection = "graph" | "cohorts";
/** The current plan viewer's subnav: the dependency graph, then the cohort cards. */
export const selectPlanSections = (plan: CurrentPlan): readonly SubnavSection<PlanSection>[] => [
  { value: "graph", label: "Graph", count: null },
  { value: "cohorts", label: "Cohorts", count: plan.cohorts.length },
];
