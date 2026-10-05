import type { OperatorArtifactReviewContext, OperatorArtifactReviewTarget } from "../review-command-types";
import type { OperatorRequest } from "../review-command-types";
export type WorkerReviewAction =
  | { readonly kind: "immediate"; readonly label: string; readonly consequence: string; readonly request: OperatorRequest }
  | { readonly kind: "feedback"; readonly label: string; readonly consequence: string; readonly request: (text: string) => OperatorRequest };
export const selectWorkerReviewActionCandidates = (context: OperatorArtifactReviewTarget): readonly WorkerReviewAction[] => {
  switch (context.worker) {
    case "spec": return [
      { kind: "immediate", label: "Accept analysis", consequence: "Accept this analysis and continue to planning.", request: { kind: "accept_analysis", target: context.target } },
      { kind: "feedback", label: "Revise analysis", consequence: "Ask the analyst to revise this analysis using your feedback.", request: (text) => ({ kind: "revise_analysis", feedback: { text, target: context.target } }) },
    ];
    case "plan": return [
      { kind: "immediate", label: "Accept plan", consequence: "Accept this plan and continue to brief writing.", request: { kind: "accept_plan", target: context.target } },
      { kind: "feedback", label: "Revise plan", consequence: "Ask the planner to revise this plan using your feedback.", request: (text) => ({ kind: "revise_plan", feedback: { text, target: context.target } }) },
    ];
    case "brief": return [
      { kind: "immediate", label: "Accept brief collection", consequence: "Accept every brief in this collection and start implementation.", request: { kind: "accept_briefs", target: context.target } },
      { kind: "feedback", label: "Revise brief collection", consequence: "Ask the brief writer to republish the entire collection with your feedback.", request: (text) => ({ kind: "revise_briefs", feedback: { text, target: context.target } }) },
    ];
    case "build": return [
      { kind: "immediate", label: "Accept build", consequence: "Freeze these build outputs and head for assessment.", request: { kind: "accept_build", target: context.target } },
      { kind: "feedback", label: "Request build changes", consequence: "Ask the builder to revise this implementation using your feedback.", request: (text) => ({ kind: "request_build_changes", feedback: { source: "build_review", text, target: context.target } }) },
      { kind: "immediate", label: "Replace pull request", consequence: "Ask the builder to publish a replacement pull request.", request: { kind: "replace_pr", target: context.target } },
    ];
    case "assessment": return [
      { kind: "immediate", label: "Accept assessment", consequence: "Accept this assessment and wait for the implementation pull request to merge.", request: { kind: "accept_assessment", target: context.target } },
      { kind: "feedback", label: "Request implementation changes", consequence: "Return this implementation to the builder with your feedback and assessment findings.", request: (text) => ({ kind: "request_implementation_changes", feedback: { source: "assessment", text, target: context.target } }) },
      { kind: "feedback", label: "Discuss assessment", consequence: "Ask the assessor to explain or revise this assessment while retaining the accepted build.", request: (text) => ({ kind: "discuss_assessment", feedback: { text, target: context.target } }) },
    ];
    case "final_integration": return [
      { kind: "immediate", label: "Confirm merged at reviewed head", consequence: "Complete final integration only if this exact reviewed pull request and head are verified as merged.", request: { kind: "confirm_merged", target: context.target } },
      { kind: "immediate", label: "Confirm closed without merge", consequence: "End final integration without accepting a merge if this exact reviewed pull request and head are verified as closed.", request: { kind: "closed_without_merge", target: context.target } },
    ];
  }
};

/** The server evaluates candidates against the pinned tree before offering them. */
export const selectWorkerReviewActions = (context: OperatorArtifactReviewContext): readonly WorkerReviewAction[] =>
  selectWorkerReviewActionCandidates(context).filter((action) =>
    context.allowed_request_kinds.includes((action.kind === "immediate" ? action.request : action.request("review feedback")).kind));

export const selectWorkerReviewRequestKinds = (context: OperatorArtifactReviewContext): readonly string[] =>
  selectWorkerReviewActions(context).map((action) => (action.kind === "immediate" ? action.request : action.request("")).kind);
