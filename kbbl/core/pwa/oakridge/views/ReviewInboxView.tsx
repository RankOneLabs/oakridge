import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { selectStableDecisionQueue, type DecisionQueueEntry } from "../lib/decision-queue";
import { useReviewInbox } from "../hooks/useReviewInbox";
import type { CohortLifecycleSummary, ReviewInbox, ReviewInboxItem } from "../types";
import { Button } from "../../components/atoms/Button";
import { FeedbackMessage } from "../../components/atoms/FeedbackMessage";
import { WorkItem } from "../components/organisms/WorkItem";
import { ProgressRow } from "../components/molecules/ProgressRow";

interface ReviewInboxViewProps {
  onSelectRun: (id: string) => void;
  onSelectArtifact: (id: string) => void;
}

const cohortKey = (value: Pick<CohortLifecycleSummary, "run_id" | "stage_instance_id" | "unit_id">): string =>
  `${value.run_id}:${value.stage_instance_id}:${value.unit_id}`;

function selectVisibleItems(data: ReviewInbox): ReviewInboxItem[] {
  const cohortsByKey = new Map(data.cohorts.map((cohort) => [cohortKey(cohort), cohort]));
  return data.items.filter((item) => item.kind !== "admission" || cohortsByKey.get(cohortKey(item))?.admission.required === true);
}

const isActionable = (item: ReviewInboxItem): boolean => item.state === "actionable" || item.kind === "pull_request_mismatch";

interface DecisionQueueState { readonly source: ReviewInbox | null; readonly entries: readonly DecisionQueueEntry[] }

export function ReviewInboxView({ onSelectRun, onSelectArtifact }: ReviewInboxViewProps) {
  const client = useQueryClient();
  const query = useReviewInbox();
  // Decisions are clicked in quick succession, so the list must not reflow
  // under the pointer: each poll is merged into what is already on screen
  // rather than replacing it. Refresh is the explicit way to compact it.
  const [queue, setQueue] = useState<DecisionQueueState>({ source: null, entries: [] });
  if (query.data && query.data !== queue.source) {
    setQueue({ source: query.data, entries: selectStableDecisionQueue(queue.entries, selectVisibleItems(query.data).filter(isActionable)) });
  }

  if (query.isError) return <FeedbackMessage tone="danger" testId="or-review-inbox-error">{query.error instanceof Error ? query.error.message : "Could not load review work."}</FeedbackMessage>;
  if (query.isPending || !query.data) return <FeedbackMessage testId="or-review-inbox-loading">Loading review work…</FeedbackMessage>;

  const cohortsByKey = new Map(query.data.cohorts.map((cohort) => [cohortKey(cohort), cohort]));
  const cohortFor = (item: ReviewInboxItem) => cohortsByKey.get(cohortKey(item));
  const visibleItems = selectVisibleItems(query.data);
  const actionable = visibleItems.filter(isActionable);
  const blocked = visibleItems.filter((item) => item.state === "blocked" && item.kind !== "pull_request_mismatch");
  const attentionKeys = new Set([...actionable, ...blocked].map((item) => cohortKey(item)));
  const underway = query.data.cohorts.filter((cohort) => !["complete", "failed", "cancelled"].includes(cohort.lifecycle) && !attentionKeys.has(cohortKey(cohort)));
  const finished = query.data.cohorts.filter((cohort) => ["complete", "failed", "cancelled"].includes(cohort.lifecycle));

  return (
    <div className="or-review-workspace" data-testid="or-review-inbox">
      <header className="or-review-workspace__header">
        <div><span className="or-review-workspace__kicker">Oakridge</span><h1>Work requiring your attention</h1><p>Review decisions are first. Work already underway stays out of the way.</p></div>
        <Button variant="secondary" className="or-review-refresh" onClick={() => { setQueue({ source: null, entries: [] }); void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] }); }}>Refresh</Button>
      </header>

      <section className="or-review-section" aria-labelledby="review-decisions">
        <div className="or-review-section__heading"><h2 id="review-decisions">Needs your decision</h2><span>{actionable.length}</span></div>
        {actionable.length === 0 && <FeedbackMessage tone="empty" testId="or-review-inbox-empty">You’re caught up. Nothing needs a decision.</FeedbackMessage>}
        {queue.entries.map((entry) => <WorkItem key={entry.item.id} item={entry.item} cohort={cohortFor(entry.item)} isSettled={entry.kind === "settled"} onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} />)}
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
