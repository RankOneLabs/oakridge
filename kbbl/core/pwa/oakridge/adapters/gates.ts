import { BLOCKER_REVIEW } from "../operator-contracts/blocker";
import { selectUnitRequirementIds } from "../lib/unit-requirements";
import type { OperatorBodyValue, OperatorDecisionDefinition, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ParkedGate, SentReviewFeedback } from "../artifact-types";
import { artifactRevisionId, compositeId, developmentPullRequestUrl, ok, type AdapterResult } from "./core";

export interface GateDecision { readonly action: string; readonly decision: OperatorDecisionDefinition }
/** Approve-effect keys the frozen gate UI labels and styles as primary; any other key would render as its raw text. */
const V1_APPROVE_ACTIONS: ReadonlySet<string> = new Set(["approve", "confirm_merged", "pass"]);
/** Whether a decision records an operator adjudication, which only the assessment view can compose. */
export const isAdjudicationDecision = (decision: OperatorDecisionDefinition): boolean =>
  decision.submit.kind === "review" && decision.adjudication != null;
export const isDisplayedReviewDecision = (decision: OperatorDecisionDefinition): boolean =>
  !isAdjudicationDecision(decision);
/** True when the decision's review offers more than one request-changes decision, so the shared request_revision action would be ambiguous. */
const hasSiblingChangeRequests = (review: string, offered: readonly OperatorDecisionDefinition[]): boolean =>
  offered.filter((candidate) => candidate.submit.kind === "review"
    && candidate.submit.review === review && candidate.submit.effect === "request_changes").length > 1;
/** The UI action for a decision. `offered` is the unit's or gate's decision list, so a review with several request-changes decisions keeps each one's key. */
export const decisionAction = (decision: OperatorDecisionDefinition, offered: readonly OperatorDecisionDefinition[]): string => {
  if (decision.submit.kind === "retry") return "rerun";
  if (decision.submit.kind === "cancel") return "fail";
  if (decision.submit.review === BLOCKER_REVIEW
      || decision.submit.effect === "request_changes" && hasSiblingChangeRequests(decision.submit.review, offered))
    return decision.submit.decision;
  if (decision.submit.effect === "request_changes") return "request_revision";
  return V1_APPROVE_ACTIONS.has(decision.submit.decision) ? decision.submit.decision : "approve";
};
export const reviewDecisions = (unit: OperatorUnitView): GateDecision[] => unit.decisions
  .filter((decision) => decision.submit.kind === "review"
    && isDisplayedReviewDecision(decision))
  .map((decision) => ({ action: decisionAction(decision, unit.decisions), decision }));
export const selectGateDecision = (gate: ParkedGate, action: string | null): OperatorDecisionDefinition | null =>
  gate.decision_definitions?.find((decision) => isDisplayedReviewDecision(decision) && decisionAction(decision, gate.decision_definitions ?? []) === action) ?? null;
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
export function selectAssessmentRevisionId(unit: OperatorUnitView, decisions: readonly OperatorDecisionDefinition[]): string | null {
  const key = decisions.find(isAdjudicationDecision)?.assessment;
  const artifact = unit.artifacts.find((candidate) => candidate.artifact_key === key);
  return artifact?.latest_revision ? artifactRevisionId(artifact, artifact.latest_revision.id) : null;
}

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
    return { id, requires_adjudication: decisions.some(isAdjudicationDecision), blocker: review === BLOCKER_REVIEW && unit.blocker?.is_open ? unit.blocker : null,
      requirement_ids: selectUnitRequirementIds(unit), gate_type: review.includes("merge") ? "merge_confirmation" : artifact ? "artifact_approval" : "gate_decision",
      gate_step: review, run_id: unit.run_id, stage_name: session.stage, unit_id: session.unit,
      artifact_revision_id: target.kind === "review"
        ? artifact ? artifactRevisionId(artifact, target.target_revision_id) : target.target_revision_id
        : null,
      assessment_revision_id: selectAssessmentRevisionId(unit, decisions),
      worktree: null, offered_decisions: decisions.map((decision) => decision.submit.kind === "review" ? decision.submit.decision : ""),
      decision_definitions: decisions,
      resume_actions: [...new Set(decisions.filter((decision) => decision.submit.kind === "review"
        && isDisplayedReviewDecision(decision)).map((decision) => decisionAction(decision, decisions)))],
      pr_url: review === "merge_confirmation" ? developmentPullRequestUrl(unit) : null,
      run_state: unit.status.kind === "done" ? "succeeded" : unit.status.kind === "cancelled" ? "cancelled" : "active", actionable: true };
  }));
}

const feedbackOf = (payload: OperatorBodyValue): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const feedback = "rework_feedback" in payload ? payload.rework_feedback : "feedback" in payload ? payload.feedback : null;
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

/** The unit's gate for its open blocker, with the blocker it answers; null when no blocker is open. */
export function selectOpenBlockerGate(unit: OperatorUnitView): (ParkedGate & { readonly blocker: NonNullable<ParkedGate["blocker"]> }) | null {
  const gates = reviewToGates(unit);
  if (!gates.ok) return null;
  const gate = gates.value.find((candidate) => candidate.gate_step === BLOCKER_REVIEW);
  return gate?.blocker?.is_open ? { ...gate, blocker: gate.blocker } : null;
}
