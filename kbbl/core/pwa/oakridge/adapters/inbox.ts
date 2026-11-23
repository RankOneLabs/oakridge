import { selectAssessmentRevisionId, selectMergeReview, reviewToGates } from "./gates";
import { BLOCKER_REVIEW, ROOT_DECLARATION, PROVIDER_ERROR_CODES } from "../operator-contracts/constants";
import type { OperatorInboxItem, OperatorRunInboxBatchEntry } from "../operator-contracts/projections/inbox";
import type { OperatorArtifactView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { CohortLifecycle, CohortLifecycleSummary, ReviewInbox, ReviewInboxItem, ReviewInboxItemKind } from "../artifact-types";
import { selectUnitAttentionLabel, type UnitAttentionLabelInput } from "../lib/run-attention";
import { selectReviewValidationRejection } from "../lib/validation-rejection";
import { artifactId, artifactRevisionId, compositeId, decisionAction, deriveStatus, isMergeWatchFailure, selectReviewPullRequestUrl, isAdjudicationDecision, isDisplayedReviewDecision, ok, repositoryKeyOf, statusInputOf, type AdapterResult } from "./core";

const isBlockerDecision = (item: OperatorInboxItem): boolean =>
  item.kind === "decision" && item.submit.kind === "review" && item.submit.review === BLOCKER_REVIEW;

function classify(item: OperatorInboxItem, artifact: OperatorArtifactView | null, isMerge: boolean): ReviewInboxItemKind {
  if (isBlockerDecision(item)) return "blocker";
  if (item.kind === "stalled") return item.failure_code === PROVIDER_ERROR_CODES.pull_request_mismatch ? "pull_request_mismatch" : "cohort_failed";
  if (item.kind === "waiting") return "cohort_blocked";
  if (item.submit.kind === "retry") return "cohort_failed";
  if (isMerge) return "merge_review";
  return artifact ? "artifact_gate" : "gate_decision";
}

function lifecycle(unit: OperatorUnitView, items: readonly OperatorInboxItem[]): CohortLifecycle {
  if (unit.status.kind === "done") return "complete";
  if (deriveStatus(statusInputOf(unit)).stage === "failed") return "failed";
  if (selectMergeReview(unit)) return "merge_review";
  if (items.some((item) => item.kind === "decision" && item.submit.kind === "review")) return "artifact_review";
  return "building";
}

function unitAttentionLabelInput(unit: OperatorUnitView): UnitAttentionLabelInput {
  return {
    cohort_key: unit.collection_key,
    brief_title: unit.label,
    repository_key: repositoryKeyOf(unit),
  };
}

export interface InboxRunContext {
  readonly workflow_name: string;
  readonly run_title: string | null;
}

export function classifyRunInbox(entry: OperatorRunInboxBatchEntry, units: readonly OperatorUnitView[], run: InboxRunContext): AdapterResult<ReviewInbox> {
  const byId = new Map(units.map((unit) => [unit.unit_id, unit]));
  const cohortUnits = units.filter((unit) => unit.stage !== null);
  const cohorts: CohortLifecycleSummary[] = [];
  for (const unit of cohortUnits) {
    const attention = unitAttentionLabelInput(unit);
    // A malformed unit must not hide the rest of the run's attention items.
    if (!attention.repository_key) continue;
    const unitItems = entry.items.filter((item) => item.unit_id === unit.unit_id);
    const name = unit.collection_key ?? unit.unit_key;
    const stageId = compositeId({ kind: "stage", runId: entry.run_id, unitId: unit.unit_id, name: unit.stage ?? unit.label });
    const artifact = unit.artifacts.find((candidate) => candidate.latest_revision && candidate.kind !== "status_record");
    const projectedGates = reviewToGates(unit);
    const gate = projectedGates.ok ? projectedGates.value[0]?.id ?? null : null;
    cohorts.push({ id: name, run_id: entry.run_id, workflow_name: run.workflow_name, stage_instance_id: stageId, stage_name: unit.stage ?? unit.label, unit_id: name,
      ...attention, repository_key: attention.repository_key, title: selectUnitAttentionLabel(attention), run_title: run.run_title, lifecycle: lifecycle(unit, unitItems), completion: { build_complete: unit.artifacts.some((candidate) => candidate.kind !== "assessment" && candidate.kind !== "status_record" && !!candidate.latest_revision),
        assessment_complete: unit.artifacts.some((candidate) => candidate.kind === "assessment" && !!candidate.latest_revision) },
      artifact_revision_id: artifact?.latest_revision ? artifactRevisionId(artifact, artifact.latest_revision.id) : null,
      artifact_url: artifact ? `oakridge/artifact/${artifactId(artifact)}` : null, gate_id: gate, gate_url: gate ? `oakridge/gate/${gate}` : null,
      pr_url: selectReviewPullRequestUrl(unit, selectMergeReview(unit)),
      updated_at: unit.attempts.at(-1)?.created_at ?? artifact?.latest_revision?.created_at ?? "" });
  }
  const seenReviews = new Set<string>();
  // A failed attempt yields both a retry decision and a stalled diagnostic.
  // The retry is the operator's one piece of work for that unit; showing the
  // diagnostic as another inbox item duplicates the same failed brief.
  const unitsWithRetry = new Set(entry.items.flatMap((item) => item.kind === "decision" && item.submit.kind === "retry" ? [item.unit_id] : []));
  // A parked blocker asks through its blocker review decisions; its "worker blocked" wait repeats the same ask.
  const unitsWithBlocker = new Set(entry.items.flatMap((item) => isBlockerDecision(item) ? [item.unit_id] : []));
  const items: ReviewInboxItem[] = entry.items.flatMap((item) => {
    const unit = byId.get(item.unit_id);
    if (!unit) return [];
    if (item.kind === "stalled" && unitsWithRetry.has(item.unit_id)) return [];
    if (item.kind === "waiting" && unitsWithBlocker.has(item.unit_id)) return [];
    const isManualMergeAvailable = deriveStatus(statusInputOf(unit)).stage === "parked" && selectMergeReview(unit) !== null;
    const retry = item.kind === "decision" && item.submit.kind === "retry" ? item.submit.worker : null;
    if (isManualMergeAvailable && (item.kind === "stalled" && isMergeWatchFailure(item.failure_code)
      || retry !== null && unit.attempts.some((attempt) => attempt.worker === retry && attempt.is_current && isMergeWatchFailure(attempt.failure?.code)))) return [];
    if (item.kind === "waiting" && item.reason.includes("review") && unit.decisions.some((decision) => decision.submit.kind === "review")) return [];
    if (item.kind === "decision" && item.submit.kind === "review") {
      const reviewKey = `${item.unit_id}:${item.submit.review}`;
      if (seenReviews.has(reviewKey)) return [];
      seenReviews.add(reviewKey);
    }
    const name = unit.collection_key ?? unit.unit_key;
    const attention = unitAttentionLabelInput(unit);
    const review = item.kind === "decision" && item.submit.kind === "review" ? item.submit.review : null;
    const openReview = unit.reviews?.find((candidate) => candidate.review === review);
    const target = openReview?.reviewed_revision_id ?? null;
    const reviewDecisions = review ? unit.decisions.filter((candidate) => candidate.submit.kind === "review" && candidate.submit.review === review) : [];
    const adjudicatingDecision = reviewDecisions.find(isAdjudicationDecision);
    const artifact = adjudicatingDecision
      ? unit.artifacts.find((candidate) => candidate.artifact_key === adjudicatingDecision.assessment) ?? null
      : unit.artifacts.find((candidate) => candidate.artifact_key === openReview?.of_artifact) ?? null;
    const revisionId = adjudicatingDecision ? selectAssessmentRevisionId(unit, reviewDecisions)
      : artifact && target ? artifactRevisionId(artifact, target) : null;
    const kind = classify(item, artifact, openReview?.confirms === "merge");
    const gate = openReview ? compositeId({ kind: "gate", runId: entry.run_id, unitId: unit.unit_id,
      name: JSON.stringify([openReview.review, openReview.reviewed_revision_id]) }) : null;
    const stageId = compositeId({ kind: "stage", runId: entry.run_id, unitId: unit.unit_id, name: unit.stage ?? ROOT_DECLARATION });
    const actions = reviewDecisions.filter((candidate) => candidate.submit.kind === "review"
      && isDisplayedReviewDecision(candidate)).map((candidate) => decisionAction(candidate, unit.decisions));
    // An adjudication payload is recorded from the assessment view; the inbox's plain controls cannot supply it.
    const requiresAdjudication = adjudicatingDecision !== undefined;
    const projectedGates = reviewToGates(unit);
    const openGate = projectedGates.ok ? projectedGates.value.find((candidate) => candidate.id === gate) : undefined;
    return [{ id: `${item.run_id}:${item.unit_id}:${item.kind === "decision" ? item.key : item.kind}`, kind,
      state: item.kind === "waiting" ? "blocked" : "actionable", run_id: entry.run_id, workflow_name: run.workflow_name, stage_instance_id: stageId,
      stage_name: unit.stage ?? unit.label, unit_id: name, lifecycle: lifecycle(unit, entry.items.filter((candidate) => candidate.unit_id === unit.unit_id)),
      ...attention, title: selectUnitAttentionLabel(attention), run_title: run.run_title, artifact_key: adjudicatingDecision ? adjudicatingDecision.assessment : artifact?.artifact_key ?? null, artifact_revision_id: revisionId,
      artifact_url: artifact ? `oakridge/artifact/${artifactId(artifact)}` : null, gate_id: gate, gate_url: gate ? `oakridge/gate/${gate}` : null, gate: openGate,
      pr_url: kind === "merge_review" || kind === "pull_request_merge" ? selectReviewPullRequestUrl(unit, openReview ?? null) : null, run_unit_id: unit.unit_id,
      resume_actions: actions, requires_adjudication: requiresAdjudication, validation_rejection: selectReviewValidationRejection(unit.recorded_decisions, reviewDecisions), blocked_by: unit.depends_on.map((id) => {
        const blocker = byId.get(id);
        return blocker ? selectUnitAttentionLabel(unitAttentionLabelInput(blocker)) || blocker.unit_id : id;
      }).filter((label) => label.length > 0) }];
  });
  return ok({ cohorts, items });
}

/** Apply a run's refreshed slice to the latest inbox, not to a snapshot captured before another run refreshed. */
export function replaceInboxRun(current: ReviewInbox, runId: string, refresh: ReviewInbox): ReviewInbox {
  return {
    cohorts: [...current.cohorts.filter((cohort) => cohort.run_id !== runId), ...refresh.cohorts.filter((cohort) => cohort.run_id === runId)],
    items: [...current.items.filter((item) => item.run_id !== runId), ...refresh.items.filter((item) => item.run_id === runId)],
  };
}
