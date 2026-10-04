import { InboxWorkerReview } from "./InboxWorkerReview";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";

import { useConfirmCohortMerged } from "../../hooks/useConfirmCohortMerged";
import { useRetryStuck } from "../../hooks/useRetryStuck";
import type { CohortLifecycleSummary, ParkedGate, ReviewInboxItem } from "../../types";

function itemToGate(item: ReviewInboxItem): ParkedGate | null {
  if (item.kind !== "artifact_gate" && item.kind !== "merge_confirmation") return null;
  if (!item.gate_id || !item.artifact_revision_id) return null;
  const mergeConfirmation = item.kind === "merge_confirmation";
  return {
    id: item.gate_id,
    stage_instance_id: item.stage_instance_id,
    gate_type: mergeConfirmation ? "merge_confirmation" : "artifact_approval",
    gate_step: mergeConfirmation ? "merge_confirmation" : "artifact_approval",
    run_id: item.run_id,
    stage_name: item.stage_name,
    unit_id: item.unit_id,
    repository_key: item.repository_key,
    artifact_revision_id: item.artifact_revision_id,
    artifact_revision_ids: item.artifact_revision_ids,
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
    case "artifact_gate": return "Artifact ready for review";
    case "merge_confirmation": return "Confirm the merged pull request";
    case "cohort_blocked": return "Waiting on another cohort";
    case "cohort_failed": return "Cohort needs recovery";
    case "cohort_retry": return "Session ended without finishing";
    case "pull_request_mismatch": return "Pull request needs attention";
    case "pull_request_merge": return "Waiting for the pull request to merge";
  }
}

export function WorkItem({ item, cohort, isSettled = false, onSelectRun, onSelectArtifact }: { item: ReviewInboxItem; cohort?: CohortLifecycleSummary; isSettled?: boolean; onSelectRun: (id: string) => void; onSelectArtifact: (id: string) => void }) {
  const gate = isSettled ? null : itemToGate(item);
  const artifactRevisionIds = item.artifact_revision_ids ?? (item.artifact_revision_id ? [item.artifact_revision_id] : []);
  const mismatch = cohort?.facts?.find((fact) => fact.key === "mismatch")?.value
    ?? cohort?.pull_request_reconciliation?.mismatch?.detail;

  return (
    <article className={isSettled ? "or-work-item or-work-item--settled" : "or-work-item"} data-testid={isSettled ? "or-review-inbox-settled-item" : "or-review-inbox-item"}>
      <div className="or-work-item__context" data-testid={gate ? "or-gate-card" : undefined}>
        <span className="or-work-item__eyebrow">{workLabel(item)}</span>
        {gate && <span className="or-work-item__eyebrow">{item.stage_name}</span>}
        <h3>{item.title || item.unit_id}</h3>
        <p>{item.repository_key || item.workflow_name}</p>
        {item.blocked_by.length > 0 && <div className="or-work-item__blocker" data-testid="or-review-inbox-blocked">Waiting on {item.blocked_by.join(", ")}</div>}
        <div className="or-work-item__links">
          {artifactRevisionIds.map((artifactId) => <Button key={artifactId} variant="link"
            onClick={() => onSelectArtifact(artifactId)} data-testid="or-inbox-artifact-link">Review {artifactId}</Button>)}
          <Button variant="link" onClick={() => onSelectRun(item.run_id)} data-testid="or-inbox-run-link">View run details</Button>
          {item.pr_url && <a href={item.pr_url} target="_blank" rel="noopener noreferrer">Open pull request</a>}
          {cohort?.links?.filter((link) => /^https?:\/\//i.test(link.url) && link.url !== item.pr_url)
            .map((link) => <a key={link.key} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}
        </div>
        {cohort?.facts?.filter((fact) => item.kind !== "pull_request_mismatch" || fact.key !== "mismatch")
          .map((fact) => <p key={fact.key}>{fact.label}: {fact.value}</p>)}
      </div>
      <div className="or-work-item__decision">
        {isSettled && <p data-testid="or-inbox-settled">No longer needs your decision.</p>}
        {!isSettled && <>
        {(item.kind === "artifact_gate" || item.kind === "merge_confirmation") && item.artifact_revision_id && <InboxWorkerReview artifactId={item.artifact_revision_id} runId={item.run_id} />}
        {!gate && item.kind === "pull_request_merge" && <PullRequestMergeAction item={item} cohort={cohort} />}
        {!gate && item.kind === "cohort_retry" && <CohortRetryAction item={item} />}
        {!gate && item.kind === "pull_request_mismatch" && <><p>{mismatch ?? "The observed pull request does not match this cohort’s durable configuration."}</p><p>Correct the pull request repository or branches, then Oakridge will reconcile it automatically.</p></>}
        {!gate && item.kind !== "pull_request_mismatch" && item.kind !== "pull_request_merge" && item.kind !== "cohort_retry" && item.kind !== "artifact_gate" && item.kind !== "merge_confirmation" && <p>{item.kind === "cohort_failed" ? "This cohort failed and ended its run. Start a new run to try again." : "This work will continue automatically when its dependencies finish."}</p>}
        </>}
      </div>
    </article>
  );
}

function CohortRetryAction({ item }: { item: ReviewInboxItem }) {
  const retry = useRetryStuck(item.run_id);
  return <>
    <p>Session ended without finishing. Retry to relaunch it.</p>
    <Button variant="secondary" onClick={() => retry.mutate({ stageInstanceId: item.stage_instance_id, unitId: item.unit_id })}
      disabled={retry.isPending}>Retry</Button>
    {retry.isError && <FeedbackMessage tone="danger">{retry.error instanceof Error ? retry.error.message : "Retry failed"}</FeedbackMessage>}
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
function PullRequestMergeAction({ item, cohort }: { item: ReviewInboxItem; cohort?: CohortLifecycleSummary }) {
  const confirmation = useConfirmCohortMerged(item.run_id);
  const cohortId = cohort?.id;
  return <>
    <p>Oakridge is watching this pull request and will continue on its own once it merges.</p>
    <Button
      variant="secondary"
      onClick={() => { if (cohortId) confirmation.mutate({ cohortId }); }}
      disabled={confirmation.isPending || !cohortId}
      data-testid="or-inbox-confirm-merged-btn"
    >
      {confirmation.isPending ? "Checking…" : "Check GitHub merge"}
    </Button>
    {confirmation.data && <FeedbackMessage>{confirmation.data.state === "complete"
      ? "GitHub reports this PR merged." : "GitHub still reports this PR open"}</FeedbackMessage>}
    {confirmation.isError && <FeedbackMessage tone="danger">{confirmation.error instanceof Error ? confirmation.error.message : "Could not confirm the merge"}</FeedbackMessage>}
  </>;
}
