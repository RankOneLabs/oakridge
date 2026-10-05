/** Exact review targets and requests mirrored from the existing cohort HTTP API. */
export interface ArtifactRef { readonly id: string; readonly version: number }
export interface BuildOutputRefs { readonly build_result: ArtifactRef; readonly pr_summary: ArtifactRef }
export interface AcceptedBuild { readonly outputs: BuildOutputRefs; readonly pr_url: string; readonly head_sha: string }
export interface BuildReviewTarget { readonly outputs: BuildOutputRefs; readonly head_sha: string }
export interface AssessmentReviewTarget { readonly assessment: ArtifactRef; readonly build: AcceptedBuild }
export interface BriefCollection { readonly members: readonly { readonly cohort_key: string; readonly ref: ArtifactRef }[] }
export interface FinalPrReviewTarget { readonly pr_summary: ArtifactRef; readonly pr_url: string; readonly head_sha: string }
interface ReviewOwner { readonly cohort_id: string; readonly expected_version: number }
export type OperatorArtifactReviewTarget = ReviewOwner & (
  | { readonly worker: "spec" | "plan"; readonly target: ArtifactRef }
  | { readonly worker: "brief"; readonly target: BriefCollection }
  | { readonly worker: "build"; readonly target: BuildReviewTarget }
  | { readonly worker: "assessment"; readonly target: AssessmentReviewTarget }
  | { readonly worker: "final_integration"; readonly target: FinalPrReviewTarget }
);
export type OperatorArtifactReviewContext = OperatorArtifactReviewTarget & { readonly allowed_request_kinds: readonly string[] };
export type ReviewTarget = ArtifactRef | BriefCollection | BuildReviewTarget | AssessmentReviewTarget | FinalPrReviewTarget;
interface ArtifactFeedback { readonly text: string; readonly target: ArtifactRef }
interface BriefFeedback { readonly text: string; readonly target: BriefCollection }
interface AssessmentFeedback { readonly text: string; readonly target: AssessmentReviewTarget }
export type OperatorRequest =
  | { readonly kind: "accept_analysis" | "accept_plan"; readonly target: ArtifactRef }
  | { readonly kind: "revise_analysis" | "revise_plan"; readonly feedback: ArtifactFeedback }
  | { readonly kind: "accept_briefs"; readonly target: BriefCollection }
  | { readonly kind: "revise_briefs"; readonly feedback: BriefFeedback }
  | { readonly kind: "accept_build" | "replace_pr"; readonly target: BuildReviewTarget }
  | { readonly kind: "request_build_changes"; readonly feedback: { readonly source: "build_review"; readonly text: string; readonly target: BuildReviewTarget } }
  | { readonly kind: "accept_assessment"; readonly target: AssessmentReviewTarget }
  | { readonly kind: "discuss_assessment"; readonly feedback: AssessmentFeedback }
  | { readonly kind: "request_implementation_changes"; readonly feedback: { readonly source: "assessment"; readonly text: string; readonly target: AssessmentReviewTarget } }
  | { readonly kind: "confirm_merged" | "closed_without_merge"; readonly target: FinalPrReviewTarget }
  | { readonly kind: "retry_provision" | "retry_analysis" | "retry_plan" | "retry_briefs" | "retry_build" | "retry_assessment" | "retry_final_integration" | "cancel" }
  | { readonly kind: "abandon"; readonly reason: string };
export type WorkflowChange =
  | { readonly kind: "set_cohort_state"; readonly state: string }
  | { readonly kind: "set_worker_state"; readonly worker: string; readonly state: string }
  | { readonly kind: "accept_outputs" | "clear_acceptance" | "fence_execution"; readonly worker: string }
  | { readonly kind: "capture_accepted_build" | "clear_accepted_build" };
