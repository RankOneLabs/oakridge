import { useQueryClient } from "@tanstack/react-query";

import { GateDecisionActions } from "../GateDecisionActions";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { useAdmitStageUnit } from "../hooks/useAdmitStageUnit";
import { useConfirmCohortMerged } from "../hooks/useConfirmCohortMerged";
import type { CohortLifecycle, CohortLifecycleSummary, ParkedGate, ReviewInboxItem } from "../types";

interface ReviewInboxViewProps {
  onSelectRun: (id: string) => void;
  onSelectArtifact: (id: string) => void;
}

const LIFECYCLE_LABELS: Record<CohortLifecycle, string> = {
  waiting_admission: "Brief approved · queued automatically",
  building: "Building",
  artifact_review: "Waiting for your review",
  revision_requested: "Changes requested",
  merge_confirmation: "Waiting for merge confirmation",
  assessing: "Checking the result",
  github_review: "Waiting for GitHub review or merge",
  pull_request_mismatch: "Pull request needs attention",
  complete: "Complete",
  failed: "Needs recovery",
};

function cohortKey(runId: string, unitId: string): string {
  return `${runId}:${unitId}`;
}

function lifecycleLabel(cohort: CohortLifecycleSummary): string {
  if (cohort.lifecycle === "complete" && cohort.pull_request_reconciliation?.completed_at) {
    return "Merged · complete";
  }
  if (cohort.lifecycle === "waiting_admission" && cohort.admission.required && !cohort.admission.admitted) {
    return cohort.admission.eligible ? "Brief approved · awaiting admission" : "Brief approved · waiting on dependencies";
  }
  return LIFECYCLE_LABELS[cohort.lifecycle];
}

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

function WorkItem({ item, cohort, onSelectRun, onSelectArtifact }: { item: ReviewInboxItem; cohort?: CohortLifecycleSummary; onSelectRun: (id: string) => void; onSelectArtifact: (id: string) => void }) {
  const gate = itemToGate(item);
  const artifactRevisionId = item.artifact_revision_id;
  const mismatch = cohort?.pull_request_reconciliation?.mismatch;

  return (
    <article className="or-work-item" data-testid="or-review-inbox-item">
      <div className="or-work-item__context">
        <span className="or-work-item__eyebrow">{workLabel(item)}</span>
        <h3>{item.title || item.unit_id}</h3>
        <p>{item.repository_key || item.workflow_name}</p>
        {item.blocked_by.length > 0 && <div className="or-work-item__blocker" data-testid="or-review-inbox-blocked">Waiting on {item.blocked_by.join(", ")}</div>}
        <div className="or-work-item__links">
          {artifactRevisionId && <button type="button" onClick={() => onSelectArtifact(artifactRevisionId)} data-testid="or-inbox-artifact-link">Open full review</button>}
          <button type="button" onClick={() => onSelectRun(item.run_id)} data-testid="or-inbox-run-link">View run details</button>
          {item.pr_url && <a href={item.pr_url} target="_blank" rel="noopener noreferrer">Open pull request</a>}
        </div>
      </div>
      <div className="or-work-item__decision">
        {gate && <GateDecisionActions gate={gate} />}
        {!gate && item.kind === "admission" && cohort && <AdmissionAction item={item} cohort={cohort} />}
        {!gate && item.kind === "pull_request_merge" && <PullRequestMergeAction item={item} />}
        {!gate && item.kind === "pull_request_mismatch" && <><p>{mismatch?.detail ?? "The observed pull request does not match this cohort’s durable configuration."}</p><p>Correct the pull request repository or branches, then Oakridge will reconcile it automatically.</p></>}
        {!gate && item.kind !== "pull_request_mismatch" && item.kind !== "pull_request_merge" && item.kind !== "admission" && <p>{item.kind === "cohort_failed" ? "Open the run to inspect the failure and retry the work." : "This work will continue automatically when its dependencies finish."}</p>}
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
    <button type="button" onClick={() => admission.mutate({ stageId: item.stage_instance_id, unitId: item.unit_id })} disabled={admission.isPending} data-testid="or-inbox-admit-btn">
      {admission.isPending ? "Admitting…" : "Admit build"}
    </button>
    {admission.isError && <p role="alert">{admission.error instanceof Error ? admission.error.message : "Admission failed"}</p>}
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
    <button
      type="button"
      onClick={() => confirmation.mutate({ cohortId, operatorComment: "Operator confirmed the pull request merged" })}
      disabled={confirmation.isPending}
      data-testid="or-inbox-confirm-merged-btn"
    >
      {confirmation.isPending ? "Confirming…" : "It’s merged — continue"}
    </button>
    {confirmation.isError && <p role="alert">{confirmation.error instanceof Error ? confirmation.error.message : "Could not confirm the merge"}</p>}
  </>;
}

function ProgressRow({ cohort, onSelectRun }: { cohort: CohortLifecycleSummary; onSelectRun: (id: string) => void }) {
  return (
    <button type="button" className="or-progress-row" onClick={() => onSelectRun(cohort.run_id)} data-testid="or-cohort-lifecycle-card">
      <span className={`or-progress-row__dot or-progress-row__dot--${cohort.lifecycle}`} aria-hidden="true" />
      <span className="or-progress-row__identity"><strong>{cohort.title || cohort.unit_id}</strong><small>{cohort.repository_key || cohort.workflow_name}</small></span>
      <span className="or-progress-row__state">{lifecycleLabel(cohort)}</span>
      <span className="or-progress-row__open">View</span>
    </button>
  );
}

export function ReviewInboxView({ onSelectRun, onSelectArtifact }: ReviewInboxViewProps) {
  const client = useQueryClient();
  const query = useReviewInbox();

  if (query.isError) return <div role="alert" className="or-review-state or-review-state--error" data-testid="or-review-inbox-error">{query.error instanceof Error ? query.error.message : "Could not load review work."}</div>;
  if (query.isPending || !query.data) return <div className="or-review-state" data-testid="or-review-inbox-loading">Loading review work…</div>;

  const cohortsByKey = new Map(query.data.cohorts.map((cohort) => [cohortKey(cohort.run_id, cohort.unit_id), cohort]));
  const cohortFor = (item: ReviewInboxItem) => cohortsByKey.get(cohortKey(item.run_id, item.unit_id));
  const visibleItems = query.data.items.filter((item) => item.kind !== "admission" || cohortFor(item)?.admission.required === true);
  const actionable = visibleItems.filter((item) => item.state === "actionable" || item.kind === "pull_request_mismatch");
  const blocked = visibleItems.filter((item) => item.state === "blocked" && item.kind !== "pull_request_mismatch");
  const attentionKeys = new Set([...actionable, ...blocked].map((item) => cohortKey(item.run_id, item.unit_id)));
  const underway = query.data.cohorts.filter((cohort) => cohort.lifecycle !== "complete" && !attentionKeys.has(cohortKey(cohort.run_id, cohort.unit_id)));
  const finished = query.data.cohorts.filter((cohort) => cohort.lifecycle === "complete");

  return (
    <div className="or-review-workspace" data-testid="or-review-inbox">
      <header className="or-review-workspace__header">
        <div><span className="or-review-workspace__kicker">Oakridge</span><h1>Work requiring your attention</h1><p>Review decisions are first. Work already underway stays out of the way.</p></div>
        <button type="button" className="or-review-refresh" onClick={() => void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] })}>Refresh</button>
      </header>

      <section className="or-review-section" aria-labelledby="review-decisions">
        <div className="or-review-section__heading"><h2 id="review-decisions">Needs your decision</h2><span>{actionable.length}</span></div>
        {actionable.length === 0 ? <div className="or-review-empty" data-testid="or-review-inbox-empty">You’re caught up. Nothing needs a decision.</div> : actionable.map((item) => <WorkItem key={item.id} item={item} cohort={cohortFor(item)} onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} />)}
      </section>

      {blocked.length > 0 && <section className="or-review-section" aria-labelledby="review-blocked"><div className="or-review-section__heading"><h2 id="review-blocked">Blocked or failed</h2><span>{blocked.length}</span></div>{blocked.map((item) => <WorkItem key={item.id} item={item} cohort={cohortFor(item)} onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} />)}</section>}

      <section className="or-review-section or-review-section--quiet" aria-labelledby="review-underway">
        <div className="or-review-section__heading"><h2 id="review-underway">Underway</h2><span>{underway.length}</span></div>
        {underway.length === 0 ? <p className="or-review-section__note">No cohorts are currently running.</p> : <div className="or-progress-list">{underway.map((cohort) => <ProgressRow key={cohort.id} cohort={cohort} onSelectRun={onSelectRun} />)}</div>}
      </section>

      {finished.length > 0 && <details className="or-review-history"><summary>Finished recently ({finished.length})</summary><div className="or-progress-list">{finished.map((cohort) => <ProgressRow key={cohort.id} cohort={cohort} onSelectRun={onSelectRun} />)}</div></details>}
    </div>
  );
}
