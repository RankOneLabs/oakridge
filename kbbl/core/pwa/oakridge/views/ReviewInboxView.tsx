import { queryKeys } from "../queryKeys";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorInbox } from "../client";
import { Button } from "../../components/atoms/Button";
import { FeedbackMessage } from "../../components/atoms/FeedbackMessage";
import { WorkItem } from "../components/organisms/WorkItem";
import { selectStableOperatorDecisionQueue, type OperatorDecisionQueueEntry } from "../lib/decision-queue";

interface ReviewInboxViewProps {
  /** Opens the run at the scope that needs attention, not at its root. */
  readonly onSelectScope: (runId: string, scopeId: string) => void;
}

export function ReviewInboxView({ onSelectScope }: ReviewInboxViewProps) {
  const query = useQuery({ queryKey: queryKeys.inbox, queryFn: fetchOperatorInbox });
  const [queue, setQueue] = useState<readonly OperatorDecisionQueueEntry[]>([]);
  useEffect(() => {
    if (query.data) setQueue((previous) => selectStableOperatorDecisionQueue(previous, query.data.items));
  }, [query.data]);
  if (!query.data) return query.error
    ? <FeedbackMessage tone="danger" testId="or-review-inbox-error">{String(query.error)}</FeedbackMessage>
    : <FeedbackMessage testId="or-review-inbox-loading">Loading review work…</FeedbackMessage>;
  return <main className="or-page" data-testid="or-review-inbox">
    {query.error && <FeedbackMessage tone="danger" testId="or-review-inbox-error">Refresh failed: {String(query.error)}</FeedbackMessage>}
    <h1>Work requiring your attention</h1>
    <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh</Button>
    {query.data.items.length === 0 && <FeedbackMessage tone="empty" testId="or-review-inbox-empty">Nothing needs attention.</FeedbackMessage>}
    {queue.map((entry, index) => <WorkItem key={`${entry.item.scope_id}:${entry.item.kind}:${index}`}
      item={entry.item} isSettled={entry.kind === "settled"} onOpen={onSelectScope} />)}
  </main>;
}
