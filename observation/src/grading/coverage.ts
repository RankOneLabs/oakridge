import type { EligibilityDecision } from "./eligibility";

export const COVERAGE_QUERY_VERSION = "human-coverage/v2";
export const DISAGREEMENT_POLICY_VERSION = "latest-kind-same-evidence/v1";
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
  readonly human_label_graded: number;
  readonly graded: number;
  readonly machine_graded: number;
  readonly pending: number;
  readonly failed: number;
  readonly disagreement: number;
  /** Distinct eligible subjects per mode. A subject with several kinds of label appears in several counts. */
  readonly graded_by_collection_mode: { readonly blind: number; readonly in_context: number; readonly unknown: number };
  readonly excluded: number;
  readonly exclusion_reasons: CoverageExclusions;
  readonly lag_seconds: number | null;
}
export interface CoverageProjection {
  readonly run_id: string;
  readonly selection_revision_id: string | null;
  readonly query_version: typeof COVERAGE_QUERY_VERSION;
  readonly selection_versions: readonly string[];
  readonly disagreement_policy_version: typeof DISAGREEMENT_POLICY_VERSION;
  readonly questions: readonly QuestionCoverage[];
  readonly truncated: boolean;
}
