import type { EligibilityDecision } from "./eligibility";

export const COVERAGE_QUERY_VERSION = "human-coverage/v1";
export type CoverageExclusionTag = Exclude<EligibilityDecision["tag"], "eligible">;
export interface CoverageExclusions {
  readonly inapplicable: number;
  readonly missing_evidence: number;
  readonly invalid_reference: number;
  readonly blocked_dependency: number;
  readonly skipped_budget: number;
}
export interface QuestionCoverage {
  readonly question_id: string;
  readonly question_version: string;
  readonly eligible: number;
  readonly graded: number;
  readonly excluded: number;
  readonly exclusion_reasons: CoverageExclusions;
  readonly lag_seconds: number | null;
}
export interface CoverageProjection {
  readonly run_id: string;
  readonly selection_revision_id: string | null;
  readonly query_version: typeof COVERAGE_QUERY_VERSION;
  readonly questions: readonly QuestionCoverage[];
  readonly truncated: boolean;
}
