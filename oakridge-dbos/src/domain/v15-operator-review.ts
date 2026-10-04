import type { V15FactContext } from "../decision/stage-machine";
import { evaluateV15Cohort, type V15EvaluationInput } from "../decision/stage-machine";
import { selectWorkerReviewActionCandidates } from "./v15-review-actions";
import type { ArtifactRef, AssessmentReviewTarget, BriefCollection, BuildReviewTarget, FinalPrReviewTarget } from "./dev-flow-v15";
import type { CohortId } from "./primitives";
interface ReviewOwner {
  readonly cohort_id: CohortId;
  readonly expected_version: number;
}
export type OperatorArtifactReviewTarget = ReviewOwner & (
  | { readonly worker: "spec" | "plan"; readonly target: ArtifactRef }
  | { readonly worker: "brief"; readonly target: BriefCollection }
  | { readonly worker: "build"; readonly target: BuildReviewTarget }
  | { readonly worker: "assessment"; readonly target: AssessmentReviewTarget }
  | { readonly worker: "final_integration"; readonly target: FinalPrReviewTarget }
);
export type OperatorArtifactReviewContext = OperatorArtifactReviewTarget & {
  readonly allowed_request_kinds: readonly string[];
};
const sameRef = (left: ArtifactRef, right: ArtifactRef) => left.id === right.id && left.version === right.version;
const refOf = (artifact: { readonly id: ArtifactRef["id"]; readonly version: number } | null) => artifact && ({ id: artifact.id, version: artifact.version });

/** Exact targets come from the owner record, including all members of a brief collection. */
export const selectArtifactReviewContext = (context: V15FactContext, selected: ArtifactRef): OperatorArtifactReviewTarget | null => {
  const owner = { cohort_id: context.cohort.id, expected_version: context.cohort.version };
  switch (context.stage) {
    case "repository_preparation": return null;
    case "spec_analysis": {
      const target = refOf(context.cohort.spec.outputs.spec_analysis);
      return context.cohort.spec.state === "awaiting_review" && target && sameRef(target, selected) ? { ...owner, worker: "spec", target } : null;
    }
    case "planning": {
      const target = refOf(context.cohort.plan.outputs.plan);
      return context.cohort.plan.state === "awaiting_review" && target && sameRef(target, selected) ? { ...owner, worker: "plan", target } : null;
    }
    case "brief_writing": {
      const target = { members: context.cohort.brief.outputs.briefs.map((member) => ({ cohort_key: member.cohort_key,
        ref: { id: member.artifact.id, version: member.artifact.version } })) };
      return context.cohort.brief.state === "awaiting_review" && target.members.some((member) => sameRef(member.ref, selected))
        ? { ...owner, worker: "brief", target } : null;
    }
    case "implementation": {
      const cohort = context.cohort;
      const build = cohort.build.response;
      if ((cohort.build.state === "awaiting_review" || cohort.state === "awaiting_merge") && build?.build_result && build.pr_summary && build.head_sha
        && [build.build_result, build.pr_summary].some((ref) => sameRef(ref, selected)))
        return { ...owner, worker: "build", target: { outputs: { build_result: build.build_result, pr_summary: build.pr_summary }, head_sha: build.head_sha } };
      const assessment = refOf(cohort.assessment.outputs.assessment);
      return cohort.assessment.state === "awaiting_review" && assessment && cohort.accepted_build && sameRef(assessment, selected)
        ? { ...owner, worker: "assessment", target: { assessment, build: cohort.accepted_build } } : null;
    }
    case "final_integration": {
      const summary = refOf(context.cohort.final_integration.outputs.pr_summary);
      const pr = context.pr;
      const head = context.cohort.final_integration.response?.head_sha;
      return context.cohort.final_integration.state === "awaiting_review" && summary && sameRef(summary, selected) && pr && head === pr.head_sha
        ? { ...owner, worker: "final_integration", target: { pr_summary: summary, pr_url: pr.pr_url, head_sha: head } } : null;
    }
  }
};

export const selectAvailableArtifactReviewContext = (input: Omit<V15EvaluationInput, "request">,
  selected: ArtifactRef): OperatorArtifactReviewContext | null => {
  const review = selectArtifactReviewContext(input.context, selected);
  if (!review) return null;
  const allowed_request_kinds = selectWorkerReviewActionCandidates(review).flatMap((action) => {
    const request = action.kind === "immediate" ? action.request : action.request("review feedback");
    const context = input.context.stage === "final_integration" && "target" in request
      ? { ...input.context, reviewed_target: review.worker === "final_integration" ? review.target : null } : input.context;
    const decision = evaluateV15Cohort({ ...input, context, request });
    return decision.ok && decision.value.kind === "apply" ? [request.kind] : [];
  });
  return { ...review, allowed_request_kinds };
};
