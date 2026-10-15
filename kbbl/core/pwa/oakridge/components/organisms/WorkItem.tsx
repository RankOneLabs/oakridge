import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { GateDecisionActions } from "./GateDecisionActions";
import { useAdmitStageUnit } from "../../hooks/useAdmitStageUnit";
import { useConfirmCohortMerged } from "../../hooks/useConfirmCohortMerged";
import type { CohortLifecycleSummary, ParkedGate, ReviewInboxItem } from "../../types";

function itemToGate(item: ReviewInboxItem): ParkedGate | null {
  if (item.kind !== "artifact_gate" && item.kind !== "merge_confirmation") return null;
  if (!item.gate_id || !item.artifact_revision_id || item.resume_actions.length === 0) return null;
  const mergeConfirmation = item.kind === "merge_confirmation";
  return {
    id: item.gate_id,
    gate_type: mergeConfirmation ? "merge_confirmation" : "artifact_approval",
    gate_step: mergeConfirmation ? "merge_confirmation" : "artifact_approval",
    run_id: item.run_id,
    stage_name: item.stage_name,
    unit_id: item.unit_id,
    repository_key: item.repository_key,
    artifact_revision_id: item.artifact_revision_id,
    worktree: null,
    resume_actions: item.resume_actions,
    pr_url: item.pr_url,
    // The inbox only queues gates whose run is still active (`get_review_inbox`
    // filters on `actionable`); stranded gates are rendered on the run instead.
    run_state: "active",
    actionable: true,
  };
}

function workLabel(item: ReviewInboxItem): string {
  switch (item.kind) {
    case "admission": return "Ready to start";
    case "artifact_gate": return "Artifact ready for review";
    case "merge_confirmation": return "Confirm the merged pull request";
    case "cohort_blocked": return "Waiting on another cohort";
    case "cohort_failed": return "Cohort needs recovery";
    case "pull_request_mismatch": return "Pull request needs attention";
    case "pull_request_merge": return "Waiting for the pull request to merge";
    case "gate_decision": return "Decision recorded";
  }
}

export function WorkItem({ item, cohort, isSettled = false, onSelectRun, onSelectArtifact }: { item: ReviewInboxItem; cohort?: CohortLifecycleSummary; isSettled?: boolean; onSelectRun: (id: string) => void; onSelectArtifact: (id: string) => void }) {
  const gate = isSettled ? null : itemToGate(item);
  const artifactRevisionId = item.artifact_revision_id;
  const mismatch = cohort?.pull_request_reconciliation?.mismatch;

  return (
    <article className={isSettled ? "or-work-item or-work-item--settled" : "or-work-item"} data-testid={isSettled ? "or-review-inbox-settled-item" : "or-review-inbox-item"}>
      <div className="or-work-item__context">
        <span className="or-work-item__eyebrow">{workLabel(item)}</span>
        <h3>{item.title || item.unit_id}</h3>
        <p>{item.repository_key || item.workflow_name}</p>
        {item.blocked_by.length > 0 && <div className="or-work-item__blocker" data-testid="or-review-inbox-blocked">Waiting on {item.blocked_by.join(", ")}</div>}
        <div className="or-work-item__links">
          {artifactRevisionId && <Button variant="link" onClick={() => onSelectArtifact(artifactRevisionId)} data-testid="or-inbox-artifact-link">Open full review</Button>}
          <Button variant="link" onClick={() => onSelectRun(item.run_id)} data-testid="or-inbox-run-link">View run details</Button>
          {item.pr_url && <a href={item.pr_url} target="_blank" rel="noopener noreferrer">Open pull request</a>}
        </div>
      </div>
      <div className="or-work-item__decision">
        {isSettled && <p data-testid="or-inbox-settled">No longer needs your decision.</p>}
        {!isSettled && <>
        {gate && <GateDecisionActions gate={gate} />}
        {!gate && item.kind === "admission" && cohort && <AdmissionAction item={item} cohort={cohort} />}
        {!gate && item.kind === "pull_request_merge" && <PullRequestMergeAction item={item} />}
        {!gate && item.kind === "pull_request_mismatch" && <><p>{mismatch?.detail ?? "The observed pull request does not match this cohort’s durable configuration."}</p><p>Correct the pull request repository or branches, then Oakridge will reconcile it automatically.</p></>}
        {!gate && item.kind !== "pull_request_mismatch" && item.kind !== "pull_request_merge" && item.kind !== "admission" && <p>{item.kind === "cohort_failed" ? "Open the run to inspect the failure and retry the work." : "This work will continue automatically when its dependencies finish."}</p>}
        </>}
      </div>
    </article>
  );
}

function AdmissionAction({ item, cohort }: { item: ReviewInboxItem; cohort: CohortLifecycleSummary }) {
  const admission = useAdmitStageUnit(item.run_id);
  if (!cohort.admission.required || cohort.admission.admitted) return null;
  if (!cohort.admission.eligible) {
    return <p>Waiting on {cohort.admission.blocked_by.length > 0 ? cohort.admission.blocked_by.join(", ") : "dependencies to complete"}.</p>;
  }
  return <>
    <p>This legacy workflow requires an explicit operator admission before the cohort starts.</p>
    <Button variant="accent-outline" onClick={() => admission.mutate({ stageId: item.stage_instance_id, unitId: item.unit_id })} disabled={admission.isPending} data-testid="or-inbox-admit-btn">
      {admission.isPending ? "Admitting…" : "Admit build"}
    </Button>
    {admission.isError && <FeedbackMessage tone="danger">{admission.error instanceof Error ? admission.error.message : "Admission failed"}</FeedbackMessage>}
  </>;
}

/**
 * The fallback behind the GitHub poller.
 *
 * Oakridge watches the pull request and closes this itself once it merges, so
 * the button is for when it cannot see the repository — no token, a private
 * fork, a merge the API does not reflect. The backend checks a confirmation
 * against the same expectations as a polled observation, so this asserts the
 * merge happened and nothing else.
 */
function PullRequestMergeAction({ item }: { item: ReviewInboxItem }) {
  const confirmation = useConfirmCohortMerged(item.run_id);
  const cohortId = `${item.stage_instance_id}:${item.unit_id}`;
  return <>
    <p>Oakridge is watching this pull request and will continue on its own once it merges.</p>
    <Button
      variant="secondary"
      onClick={() => confirmation.mutate({ cohortId, operatorComment: "Operator confirmed the pull request merged" })}
      disabled={confirmation.isPending}
      data-testid="or-inbox-confirm-merged-btn"
    >
      {confirmation.isPending ? "Confirming…" : "It’s merged — continue"}
    </Button>
    {confirmation.isError && <FeedbackMessage tone="danger">{confirmation.error instanceof Error ? confirmation.error.message : "Could not confirm the merge"}</FeedbackMessage>}
  </>;
}

