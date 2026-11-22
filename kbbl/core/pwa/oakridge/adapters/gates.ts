import { BLOCKER_REVIEW } from "../operator-contracts/constants";
import { selectUnitRequirementIds } from "../lib/unit-requirements";
import { selectReviewValidationRejection } from "../lib/validation-rejection";
import type { OperatorBodyValue, OperatorDecisionDefinition, OperatorOpenReview, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ParkedGate, SentReviewFeedback } from "../artifact-types";
import { artifactRevisionId, compositeId, selectReviewPullRequestUrl, ok, type AdapterResult } from "./core";

export interface GateDecision { readonly action: string; readonly decision: OperatorDecisionDefinition }
export const isAdjudicationDecision = (decision: OperatorDecisionDefinition): boolean =>
  decision.submit.kind === "review" && decision.operation !== undefined && decision.operation !== "plain";
export const isDisplayedReviewDecision = (decision: OperatorDecisionDefinition): boolean => !isAdjudicationDecision(decision);
export const decisionAction = (decision: OperatorDecisionDefinition, _offered?: readonly OperatorDecisionDefinition[]): string =>
  decision.submit.kind === "review" ? decision.submit.decision : decision.key;
export const reviewDecisions = (unit: OperatorUnitView): GateDecision[] => unit.decisions
  .filter((decision) => decision.submit.kind === "review" && isDisplayedReviewDecision(decision))
  .map((decision) => ({ action: decisionAction(decision), decision }));
export const selectGateDecision = (gate: ParkedGate, action: string | null): OperatorDecisionDefinition | null =>
  gate.decision_definitions?.find((decision) => isDisplayedReviewDecision(decision) && decisionAction(decision) === action) ?? null;
export const selectMergeReview = (unit: OperatorUnitView): OperatorOpenReview | null =>
  unit.reviews?.find((review) => review.confirms === "merge") ?? null;
export const selectMergeDecision = (unit: OperatorUnitView): OperatorOpenReview["decisions"][number] | null =>
  selectMergeReview(unit)?.decisions.find((decision) => decision.effect === "approve") ?? null;

export function selectReviewSession(unit: OperatorUnitView, review: OperatorOpenReview): string | null {
  return [...unit.attempts].reverse().find((attempt) => review.producer_workers.includes(attempt.worker))?.kbbl_session_id ?? null;
}

export function selectAssessmentRevisionId(unit: OperatorUnitView, decisions: readonly OperatorDecisionDefinition[]): string | null {
  const key = decisions.find(isAdjudicationDecision)?.assessment;
  const artifact = unit.artifacts.find((candidate) => candidate.artifact_key === key);
  return artifact?.latest_revision ? artifactRevisionId(artifact, artifact.latest_revision.id) : null;
}

export function reviewToGates(unit: OperatorUnitView): AdapterResult<ParkedGate[]> {
  return ok((unit.reviews ?? []).map((review) => {
    const decisions = unit.decisions.filter((decision) => decision.submit.kind === "review" && decision.submit.review === review.review);
    const artifact = unit.artifacts.find((candidate) => candidate.artifact_key === review.of_artifact);
    const id = compositeId({ kind: "gate", runId: unit.run_id, unitId: unit.unit_id,
      name: JSON.stringify([review.review, review.reviewed_revision_id]) });
    return { id, requires_adjudication: decisions.some(isAdjudicationDecision), validation_rejection: selectReviewValidationRejection(unit.recorded_decisions, decisions),
      blocker: review.review === BLOCKER_REVIEW && unit.blocker?.is_open ? unit.blocker : null,
      requirement_ids: selectUnitRequirementIds(unit), gate_type: review.confirms === "merge" ? "merge" : artifact ? "artifact_approval" : "gate_decision",
      gate_step: review.review, reviewed_revision_id: review.reviewed_revision_id, session_id: selectReviewSession(unit, review),
      producer_labels: review.producer_workers.map((key) => unit.workers?.find((worker) => worker.key === key)?.label ?? key),
      run_id: unit.run_id, stage_name: unit.stage ?? unit.label, unit_id: unit.collection_key ?? unit.unit_key,
      artifact_revision_id: artifact ? artifactRevisionId(artifact, review.reviewed_revision_id) : review.reviewed_revision_id,
      assessment_revision_id: selectAssessmentRevisionId(unit, decisions),
      worktree: null, offered_decisions: review.decisions.map((decision) => decision.key),
      decision_definitions: decisions, resume_actions: decisions.filter(isDisplayedReviewDecision).map((decision) => decisionAction(decision)),
      pr_url: selectReviewPullRequestUrl(unit, review),
      run_state: unit.status.kind === "done" ? "succeeded" : unit.status.kind === "cancelled" ? "cancelled" : "active", actionable: true };
  }));
}

const feedbackOf = (payload: OperatorBodyValue): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const feedback = "feedback" in payload ? payload.feedback : null;
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
      return { id: decision.id, target_revision_id: decision.target_revision_id,
        run_id: unit.run_id, stage_name: unit.stage ?? unit.label, unit_id: unit.collection_key ?? unit.unit_key, review: decision.review,
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
