import { selectVersionedComponent } from "../lib/artifact-version";
import { selectUnitRequirementIds } from "../lib/unit-requirements";
import type { OperatorBodyValue, OperatorDecisionDefinition, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ParkedGate, SentReviewFeedback } from "../artifact-types";
import { artifactRevisionId, compositeId, developmentPullRequestUrl, ok, type AdapterResult } from "./core";

export interface GateDecision { readonly action: string; readonly decision: OperatorDecisionDefinition }
export const REQUEST_BUILD_CHANGES = "request_build_changes";
/** Approve-effect keys the frozen gate UI labels and styles as primary; any other key would render as its raw text. */
const V1_APPROVE_ACTIONS: ReadonlySet<string> = new Set(["approve", "confirm_merged", "pass"]);
/** The builder handoff records this decision with its next actions; the gate never offers it bare. */
export const isDisplayedReviewDecision = (review: string, decision: string): boolean =>
  review !== "assessment_review" || decision !== REQUEST_BUILD_CHANGES;
export const decisionAction = (decision: OperatorDecisionDefinition): string => {
  if (decision.submit.kind === "retry") return "rerun";
  if (decision.submit.kind === "cancel") return "fail";
  if (decision.submit.review === "blocker_review"
      || decision.submit.review === "assessment_review" && decision.submit.effect === "request_changes")
    return decision.submit.decision;
  if (decision.submit.effect === "request_changes") return "request_revision";
  return V1_APPROVE_ACTIONS.has(decision.submit.decision) ? decision.submit.decision : "approve";
};
export const reviewDecisions = (unit: OperatorUnitView): GateDecision[] => unit.decisions
  .filter((decision) => decision.submit.kind === "review"
    && isDisplayedReviewDecision(decision.submit.review, decision.submit.decision))
  .map((decision) => ({ action: decisionAction(decision), decision }));
export const selectGateDecision = (gate: ParkedGate, action: string | null): OperatorDecisionDefinition | null =>
  gate.decision_definitions?.find((decision) => decisionAction(decision) === action) ?? null;
/** The frozen sidebar matches gates to sessions by stage and unit label. The
 * development cohort runs builder and assessor in separate sessions on one
 * v2 unit, so its reviews must use the session that owns the operator handoff. */
const developmentReviewSession = (unit: OperatorUnitView, review: string): { readonly stage: string; readonly unit: string } => {
  if (unit.stage === "cohort" && review === "assessment_review")
    return { stage: "assessment", unit: unit.collection_key ?? unit.unit_key };
  if (unit.stage === "cohort" && (review === "merge_confirmation" || review === "pr_closed"))
    return { stage: "builder", unit: unit.collection_key ?? unit.unit_key };
  if (unit.stage === "brief" && review === "brief_review")
    return { stage: "brief", unit: "shared writer" };
  return { stage: unit.stage ?? unit.label, unit: unit.collection_key ?? unit.unit_key };
};
export function reviewToGates(unit: OperatorUnitView): AdapterResult<ParkedGate[]> {
  const byReview = new Map<string, OperatorDecisionDefinition[]>();
  for (const decision of unit.decisions) {
    if (decision.submit.kind !== "review") continue;
    byReview.set(decision.submit.review, [...(byReview.get(decision.submit.review) ?? []), decision]);
  }
  return ok([...byReview].map(([review, decisions]) => {
    const session = developmentReviewSession(unit, review);
    const target = decisions[0].submit;
    const artifact = target.kind === "review" ? unit.artifacts.find((candidate) => candidate.latest_revision?.id === target.target_revision_id) : null;
    const id = compositeId({ kind: "gate", runId: unit.run_id, unitId: unit.unit_id,
      name: `${review}:${target.kind === "review" ? target.target_revision_id : "unknown"}` });
    return { id, requires_adjudication: artifact?.schema === "assessment_body" && selectVersionedComponent(artifact.schema, artifact.latest_revision?.artifact_schema_version) === "dev-current-assessment-viewer", blocker: review === "blocker_review" && unit.blocker?.is_open ? unit.blocker : null,
      requirement_ids: selectUnitRequirementIds(unit), gate_type: review.includes("merge") ? "merge_confirmation" : artifact ? "artifact_approval" : "gate_decision",
      gate_step: review, run_id: unit.run_id, stage_name: session.stage, unit_id: session.unit,
      artifact_revision_id: target.kind === "review"
        ? artifact ? artifactRevisionId(artifact, target.target_revision_id) : target.target_revision_id
        : null,
      worktree: null, offered_decisions: decisions.map((decision) => decision.submit.kind === "review" ? decision.submit.decision : ""),
      decision_definitions: decisions,
      resume_actions: [...new Set(decisions.filter((decision) => decision.submit.kind === "review"
        && isDisplayedReviewDecision(decision.submit.review, decision.submit.decision)).map(decisionAction))],
      pr_url: review === "merge_confirmation" ? developmentPullRequestUrl(unit) : null,
      run_state: unit.status.kind === "done" ? "succeeded" : unit.status.kind === "cancelled" ? "cancelled" : "active", actionable: true };
  }));
}

const feedbackOf = (payload: OperatorBodyValue): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const feedback = "builder_feedback" in payload ? payload.builder_feedback : "feedback" in payload ? payload.feedback : null;
  return typeof feedback === "string" && feedback.trim() ? feedback : null;
};
/** Changes requested on a revision that is still its artifact's latest: sent, and not yet answered by a new revision. */
export function sentReviewFeedback(unit: OperatorUnitView): SentReviewFeedback[] {
  const latestRevisionIds = new Set(unit.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision.id] : []));
  // Oldest first, so each target keeps its latest decision.
  const latestByTarget = new Map(unit.recorded_decisions.map((decision) => [decision.target_revision_id, decision]));
  return [...latestByTarget.values()]
    .filter((decision) => decision.effect === "request_changes" && latestRevisionIds.has(decision.target_revision_id))
    .map((decision) => {
      const session = developmentReviewSession(unit, decision.review);
      return { id: decision.id, target_revision_id: decision.target_revision_id,
        run_id: unit.run_id, stage_name: session.stage, unit_id: session.unit, review: decision.review,
        decision: decision.decision, feedback: feedbackOf(decision.payload), sent_at: decision.created_at };
    });
}
