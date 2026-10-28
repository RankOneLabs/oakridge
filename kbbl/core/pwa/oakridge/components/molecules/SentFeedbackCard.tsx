import { formatExactTime, formatRelative } from "../../../lib/time";
import { selectSentFeedbackTitle } from "../../lib/sent-review-feedback";
import type { SentReviewFeedback } from "../../types";

/** Feedback the operator already sent, kept on screen until the agent answers it with a new revision. */
export function SentFeedbackCard({ feedback }: { feedback: SentReviewFeedback }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4" data-testid="or-sent-feedback">
      <div className="flex flex-wrap items-center gap-2.5 text-sm">
        <strong>{selectSentFeedbackTitle(feedback.decision)}</strong>
        <span className="text-[var(--text-secondary)]">{feedback.stage_name}</span>
        {feedback.unit_id !== "0" && <span className="font-mono text-xs text-[var(--text-muted)]">{feedback.unit_id}</span>}
        <time className="text-xs text-[var(--text-muted)]" dateTime={feedback.sent_at} title={formatExactTime(feedback.sent_at)}>{formatRelative(feedback.sent_at)}</time>
      </div>
      {feedback.feedback && <p className="m-0 whitespace-pre-wrap text-sm text-[var(--text-secondary)]" data-testid="or-sent-feedback-text">{feedback.feedback}</p>}
      <p className="m-0 text-xs text-[var(--text-muted)]">Sent. Waiting for a new revision.</p>
    </div>
  );
}
