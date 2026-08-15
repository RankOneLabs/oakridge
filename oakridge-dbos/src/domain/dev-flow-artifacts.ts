export type FindingSeverity = "blocking" | "warning" | "info";
export type RequirementStatus = "implementable" | "blocked" | "ambiguous";
export interface SpecFinding { readonly id: string; readonly description: string; readonly severity: FindingSeverity }
export interface SpecRequirement { readonly id: string; readonly description: string; readonly status: RequirementStatus }
export interface DevRisk { readonly description: string; readonly mitigation: string }
export interface SpecAnalysisBody { readonly summary: string; readonly source_spec_refs: readonly string[]; readonly findings: readonly SpecFinding[]; readonly requirements: readonly SpecRequirement[]; readonly risks: readonly DevRisk[] }
export interface PlanCohort { readonly id: string; readonly repository_key: string | null; readonly title: string; readonly scope: string; readonly depends_on: readonly string[]; readonly description: string | null; readonly files_in_scope: readonly string[]; readonly decisions: readonly string[]; readonly acceptance_criteria: readonly string[] }
export interface PlanScope { readonly in_scope: readonly string[]; readonly out_of_scope: readonly string[] }
export interface PlanBody { readonly summary: string; readonly cohorts: readonly PlanCohort[]; readonly dependency_order: readonly string[]; readonly scope: PlanScope; readonly acceptance_criteria: readonly string[]; readonly risks: readonly DevRisk[] }
export interface BriefDecision { readonly decision: string; readonly rationale: string }
export interface RejectedApproach { readonly approach: string; readonly reason: string }
export interface BuildBriefBody { readonly cohort_id: string; readonly repository_key: string; readonly title: string; readonly depends_on: readonly string[]; readonly goal: string; readonly files_in_scope: readonly string[]; readonly decisions_made: readonly BriefDecision[]; readonly approaches_rejected: readonly RejectedApproach[]; readonly acceptance_criteria: readonly string[]; readonly next_action: string }
export interface TestEvidence { readonly passed: number; readonly failed: number; readonly output: string | null; readonly summary: string | null; readonly cargo_test_output: string | null }
export interface DelegatedBuildMetadata { readonly cohort_id: string | null; readonly session_id: string | null; readonly branch: string | null }
export interface BuildIssue { readonly description: string; readonly severity: FindingSeverity }
export interface BuildResultBody { readonly repository_key: string | null; readonly summary: string; readonly changed_files: readonly string[]; readonly tests: TestEvidence; readonly delegated_session_metadata: DelegatedBuildMetadata | null; readonly known_issues: readonly BuildIssue[] }
export type AssessmentVerdict = "pass" | "pass_with_notes" | "fail";
export type CriterionStatus = "met" | "not_met" | "partial";
export interface AssessmentFinding { readonly criterion: string | null; readonly status: CriterionStatus | null; readonly evidence: string | null; readonly description: string | null }
export interface AssessmentBody { readonly verdict: AssessmentVerdict; readonly findings: readonly AssessmentFinding[]; readonly test_evidence: TestEvidence | null; readonly recommended_next_actions: readonly string[] }
export type PrReviewStatus = "draft" | "ready" | "changes_requested" | "approved" | "merged" | "closed";
export interface PrSummaryBody { readonly pr_url: string; readonly branch: string; readonly summary: string; readonly review_status: PrReviewStatus | null }
