import type { OperatorInboxItem, OperatorRunInboxBatchEntry, OperatorUnitView } from "../operator-contracts";
import type { CohortLifecycle, CohortLifecycleSummary, ReviewInbox, ReviewInboxItem, ReviewInboxItemKind } from "../types";
import { artifactId, artifactRevisionId, compositeId, decisionAction, deriveStatus, developmentPullRequestUrl, isDisplayedReviewDecision, isVisibleDevelopmentArtifact, ok, statusInputOf, type AdapterResult } from "./core";

/** This table describes only the six-stage development workflow. */
const DEVELOPMENT_REVIEWS: Readonly<Record<string, ReviewInboxItemKind>> = {
  "analysis:analysis_review": "artifact_gate", "planning:plan_review": "artifact_gate", "brief:brief_review": "artifact_gate",
  "cohort:admission": "admission", "cohort:assessment_review": "artifact_gate", "cohort:merge_confirmation": "merge_confirmation",
  "integration:integration_review": "artifact_gate", "integration:merge_confirmation": "merge_confirmation",
  "cohort:pr_closed": "gate_decision", "integration:pr_closed": "gate_decision",
};

function classify(item: OperatorInboxItem, unit: OperatorUnitView): ReviewInboxItemKind {
  if (item.kind === "stalled") return "cohort_failed";
  if (item.kind === "waiting") return item.reason.includes("pull request") ? "pull_request_merge" : "cohort_blocked";
  if (item.submit.kind === "retry") return "cohort_failed";
  if (item.submit.kind !== "review") return "gate_decision";
  return DEVELOPMENT_REVIEWS[`${unit.stage}:${item.submit.review}`] ?? "gate_decision";
}

function lifecycle(unit: OperatorUnitView, items: readonly OperatorInboxItem[]): CohortLifecycle {
  if (unit.status.kind === "done") return "complete";
  if (deriveStatus(statusInputOf(unit)).stage === "failed") return "failed";
  if (items.some((item) => item.kind === "decision" && item.submit.kind === "review" && item.submit.review === "admission")) return "waiting_admission";
  if (items.some((item) => item.kind === "decision" && item.submit.kind === "review" && item.submit.review.includes("merge"))) return "merge_confirmation";
  if (items.some((item) => item.kind === "decision" && item.submit.kind === "review")) return "artifact_review";
  return unit.stage === "integration" ? "github_review" : "building";
}

export function classifyDevelopmentInbox(entry: OperatorRunInboxBatchEntry, units: readonly OperatorUnitView[], runTitle: string | null = null): AdapterResult<ReviewInbox> {
  const byId = new Map(units.map((unit) => [unit.unit_id, unit]));
  const cohorts: CohortLifecycleSummary[] = units.filter((unit) => unit.stage === "cohort" || unit.stage === "integration").map((unit) => {
    const unitItems = entry.items.filter((item) => item.unit_id === unit.unit_id);
    const name = unit.collection_key ?? unit.unit_key;
    const stageId = compositeId({ kind: "stage", runId: entry.run_id, unitId: unit.unit_id, name: unit.stage! });
    const artifact = unit.artifacts.find((candidate) => candidate.latest_revision && isVisibleDevelopmentArtifact(candidate));
    const review = unitItems.find((item) => item.kind === "decision" && item.submit.kind === "review");
    const reviewName = review?.kind === "decision" && review.submit.kind === "review" ? review.submit.review : null;
    const gate = reviewName ? compositeId({ kind: "gate", runId: entry.run_id, unitId: unit.unit_id, name: reviewName }) : null;
    return { id: name, run_id: entry.run_id, workflow_name: "development", stage_instance_id: stageId, stage_name: unit.stage!, unit_id: name,
      title: unit.label, run_title: runTitle, lifecycle: lifecycle(unit, unitItems), completion: { build_complete: unit.artifacts.some((candidate) => candidate.artifact_key === "build_result" && !!candidate.latest_revision),
        assessment_complete: unit.artifacts.some((candidate) => candidate.artifact_key === "assessment" && !!candidate.latest_revision) },
      admission: { required: unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "admission"),
        admitted: !unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "admission"),
        eligible: true, blocked_by: [] }, artifact_revision_id: artifact?.latest_revision ? artifactRevisionId(artifact, artifact.latest_revision.id) : null,
      artifact_url: artifact ? `oakridge/artifact/${artifactId(artifact)}` : null, gate_id: gate, gate_url: gate ? `oakridge/gate/${gate}` : null,
      pr_url: developmentPullRequestUrl(unit),
      updated_at: unit.attempts.at(-1)?.created_at ?? artifact?.latest_revision?.created_at ?? "" };
  });
  const seenReviews = new Set<string>();
  // A failed attempt yields both a retry decision and a stalled diagnostic.
  // The retry is the operator's one piece of work for that unit; showing the
  // diagnostic as another inbox item duplicates the same failed brief.
  const unitsWithRetry = new Set(entry.items.flatMap((item) => item.kind === "decision" && item.submit.kind === "retry" ? [item.unit_id] : []));
  const items: ReviewInboxItem[] = entry.items.flatMap((item) => {
    const unit = byId.get(item.unit_id);
    if (!unit) return [];
    if (item.kind === "decision" && item.submit.kind === "review"
      && !isDisplayedReviewDecision(item.submit.review, item.submit.decision)) return [];
    if (item.kind === "stalled" && unitsWithRetry.has(item.unit_id)) return [];
    const isManualMergeAvailable = deriveStatus(statusInputOf(unit)).stage === "parked"
      && unit.decisions.some((decision) => decision.submit.kind === "review"
        && decision.submit.review === "merge_confirmation" && decision.submit.decision === "confirm_merged");
    if (isManualMergeAvailable && (item.kind === "stalled" && item.detail.startsWith("pr_watch failed:")
      || item.kind === "decision" && item.submit.kind === "retry" && item.submit.worker === "pr_watch")) return [];
    if (item.kind === "waiting" && item.reason.includes("review") && unit.decisions.some((decision) => decision.submit.kind === "review")) return [];
    if (item.kind === "decision" && item.submit.kind === "review") {
      const reviewKey = `${item.unit_id}:${item.submit.review}`;
      if (seenReviews.has(reviewKey)) return [];
      seenReviews.add(reviewKey);
    }
    const kind = classify(item, unit);
    const name = unit.collection_key ?? unit.unit_key;
    const review = item.kind === "decision" && item.submit.kind === "review" ? item.submit.review : null;
    const target = item.kind === "decision" && item.submit.kind === "review" ? item.submit.target_revision_id : null;
    const artifact = target ? unit.artifacts.find((candidate) => candidate.latest_revision?.id === target) : null;
    const gate = review ? compositeId({ kind: "gate", runId: entry.run_id, unitId: unit.unit_id, name: review }) : null;
    const stageId = compositeId({ kind: "stage", runId: entry.run_id, unitId: unit.unit_id, name: unit.stage ?? "$root" });
    const actions = review ? unit.decisions.filter((candidate) => candidate.submit.kind === "review"
      && candidate.submit.review === review
      && isDisplayedReviewDecision(candidate.submit.review, candidate.submit.decision)).map(decisionAction) : [];
    return [{ id: `${item.run_id}:${item.unit_id}:${item.kind === "decision" ? item.key : item.kind}`, kind,
      state: item.kind === "waiting" ? "blocked" : "actionable", run_id: entry.run_id, workflow_name: "development", stage_instance_id: stageId,
      stage_name: unit.stage ?? "$root", unit_id: name, lifecycle: lifecycle(unit, entry.items.filter((candidate) => candidate.unit_id === unit.unit_id)),
      title: unit.label, run_title: runTitle, artifact_key: artifact?.artifact_key ?? null, artifact_revision_id: artifact && target ? artifactRevisionId(artifact, target) : null,
      artifact_url: artifact ? `oakridge/artifact/${artifactId(artifact)}` : null, gate_id: gate, gate_url: gate ? `oakridge/gate/${gate}` : null,
      pr_url: kind === "merge_confirmation" || kind === "pull_request_merge" ? developmentPullRequestUrl(unit) : null,
      resume_actions: actions, blocked_by: unit.depends_on.map((id) => byId.get(id)?.label ?? id) }];
  });
  return ok({ cohorts, items });
}

/** Apply a run's refreshed slice to the latest inbox, not to a snapshot captured before another run refreshed. */
export function replaceDevelopmentInboxRun(current: ReviewInbox, runId: string, refresh: ReviewInbox): ReviewInbox {
  return {
    cohorts: [...current.cohorts.filter((cohort) => cohort.run_id !== runId), ...refresh.cohorts.filter((cohort) => cohort.run_id === runId)],
    items: [...current.items.filter((item) => item.run_id !== runId), ...refresh.items.filter((item) => item.run_id === runId)],
  };
}
