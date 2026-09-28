import { useQueryClient } from "@tanstack/react-query";

import { selectReviewCohortKey } from "../lib/run-attention";
import { useReviewInbox } from "../hooks/useReviewInbox";
import type { ReviewInboxItem } from "../types";
import { Button } from "../../components/atoms/Button";
import { FeedbackMessage } from "../../components/atoms/FeedbackMessage";
import { WorkItem } from "../components/organisms/WorkItem";
import { ProgressRow } from "../components/molecules/ProgressRow";

interface ReviewInboxViewProps {
  onSelectRun: (id: string) => void;
  onSelectArtifact: (id: string) => void;
}

export function ReviewInboxView({ onSelectRun, onSelectArtifact }: ReviewInboxViewProps) {
  const client = useQueryClient();
  const query = useReviewInbox();

  if (query.isError) return <FeedbackMessage tone="danger" testId="or-review-inbox-error">{query.error instanceof Error ? query.error.message : "Could not load review work."}</FeedbackMessage>;
  if (query.isPending || !query.data) return <FeedbackMessage testId="or-review-inbox-loading">Loading review work…</FeedbackMessage>;

  const cohortsByKey = new Map(query.data.cohorts.map((cohort) => [selectReviewCohortKey(cohort), cohort]));
  const cohortFor = (item: ReviewInboxItem) => cohortsByKey.get(selectReviewCohortKey(item));
  const visibleItems = query.data.items.filter((item) => item.kind !== "admission" || cohortFor(item)?.admission.required === true);
  const actionable = visibleItems.filter((item) => item.state === "actionable" || item.kind === "pull_request_mismatch");
  const blocked = visibleItems.filter((item) => item.state === "blocked" && item.kind !== "pull_request_mismatch");
  const attentionKeys = new Set([...actionable, ...blocked].map((item) => selectReviewCohortKey(item)));
  const underway = query.data.cohorts.filter((cohort) => cohort.lifecycle !== "complete" && !attentionKeys.has(selectReviewCohortKey(cohort)));
  const finished = query.data.cohorts.filter((cohort) => cohort.lifecycle === "complete");

  return (
    <div className="or-review-workspace" data-testid="or-review-inbox">
      <header className="or-review-workspace__header">
        <div><span className="or-review-workspace__kicker">Oakridge</span><h1>Work requiring your attention</h1><p>Review decisions are first. Work already underway stays out of the way.</p></div>
        <Button variant="secondary" className="or-review-refresh" onClick={() => void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] })}>Refresh</Button>
      </header>

      <section className="or-review-section" aria-labelledby="review-decisions">
        <div className="or-review-section__heading"><h2 id="review-decisions">Needs your decision</h2><span>{actionable.length}</span></div>
        {actionable.length === 0 ? <FeedbackMessage tone="empty" testId="or-review-inbox-empty">You’re caught up. Nothing needs a decision.</FeedbackMessage> : actionable.map((item) => <WorkItem key={item.id} item={item} cohort={cohortFor(item)} onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} />)}
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
