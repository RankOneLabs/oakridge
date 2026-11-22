import type { CanonicalSpec, CurrentAnalysis, CurrentBrief, CurrentPlan } from "./current-contract";
import { selectAnalysisFindings } from "./current-analysis";

/** Gradeable item paths of each current artifact: what its viewer grades item by item, and what "Show automatic grades" reveals. */
export const selectAnalysisItemPaths = (analysis: CurrentAnalysis): readonly string[] =>
  selectAnalysisFindings(analysis).map((reference) => reference.path);

export const selectSpecItemPaths = (spec: CanonicalSpec): readonly string[] =>
  spec.requirements.map((_, index) => `/requirements/${index}`);

export const selectPlanItemPaths = (plan: CurrentPlan): readonly string[] =>
  plan.cohorts.flatMap((cohort, cohortIndex) => cohort.allocations.map((_, index) => `/cohorts/${cohortIndex}/allocations/${index}`));

export const selectBriefItemPaths = (brief: CurrentBrief): readonly string[] =>
  brief.build_items.map((_, index) => `/build_items/${index}`);
