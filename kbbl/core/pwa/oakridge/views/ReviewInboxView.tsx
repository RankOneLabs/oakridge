import { useRef } from "react";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { Button } from "../../components/atoms/Button";
import { FeedbackMessage } from "../../components/atoms/FeedbackMessage";
import { WorkItem } from "../components/organisms/WorkItem";
import { selectStableOperatorDecisionQueue, type OperatorDecisionQueueEntry } from "../lib/decision-queue";

interface ReviewInboxViewProps {
  /** Opens the run at the unit that needs attention, not at its root. */
  readonly onSelectUnit: (runId: string, unitId: string) => void;
}

export function ReviewInboxView({ onSelectUnit }: ReviewInboxViewProps) {
  const query = useReviewInbox();
  const order = useRef<readonly OperatorDecisionQueueEntry[]>([]);
  const queue = query.data ? selectStableOperatorDecisionQueue(order.current, query.data.items) : order.current;
  order.current = queue;
  if (!query.data) return query.error
    ? <FeedbackMessage tone="danger" testId="or-review-inbox-error">{String(query.error)}</FeedbackMessage>
    : <FeedbackMessage testId="or-review-inbox-loading">Loading review work…</FeedbackMessage>;
  return <main className="or-page" data-testid="or-review-inbox">
    {query.error && <FeedbackMessage tone="danger" testId="or-review-inbox-error">Refresh failed: {String(query.error)}</FeedbackMessage>}
    <h1>Work requiring your attention</h1>
    <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh</Button>
    {query.data.items.length === 0 && <FeedbackMessage tone="empty" testId="or-review-inbox-empty">Nothing needs attention.</FeedbackMessage>}
    {queue.map((entry, index) => <WorkItem key={`${entry.item.unit_id}:${entry.item.kind}:${index}`}
      item={entry.item} isSettled={entry.kind === "settled"} onOpen={onSelectUnit} />)}
  </main>;
}
