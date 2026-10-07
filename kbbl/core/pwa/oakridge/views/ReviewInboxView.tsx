import { queryKeys } from "../queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorInbox } from "../client";
import { Button } from "../../components/atoms/Button";
import { FeedbackMessage } from "../../components/atoms/FeedbackMessage";

interface ReviewInboxViewProps {
  readonly onSelectRun: (id: string) => void;
  readonly onSelectArtifact: (id: string) => void;
}

export function ReviewInboxView({ onSelectRun }: ReviewInboxViewProps) {
  const query = useQuery({ queryKey: queryKeys.inbox, queryFn: fetchOperatorInbox });
  if (!query.data) return query.error
    ? <FeedbackMessage tone="danger" testId="or-review-inbox-error">{String(query.error)}</FeedbackMessage>
    : <FeedbackMessage testId="or-review-inbox-loading">Loading review work…</FeedbackMessage>;
  return <main className="or-page" data-testid="or-review-inbox">
    {query.error && <FeedbackMessage tone="danger" testId="or-review-inbox-error">Refresh failed: {String(query.error)}</FeedbackMessage>}
    <h1>Work requiring your attention</h1>
    <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh</Button>
    {query.data.items.length === 0 && <FeedbackMessage tone="empty" testId="or-review-inbox-empty">Nothing needs attention.</FeedbackMessage>}
    {query.data.items.map((item, index) => <section key={`${item.scope_id}:${index}`}>
      <h2>{item.kind === "diagnostic" ? item.detail : item.label}</h2>
      {item.kind === "command" && <p>{item.consequence}</p>}
      {item.kind === "wait" && <p>{item.reason}</p>}
      <Button onClick={() => onSelectRun(item.run_id)}>Open run</Button>
    </section>)}
  </main>;
}
