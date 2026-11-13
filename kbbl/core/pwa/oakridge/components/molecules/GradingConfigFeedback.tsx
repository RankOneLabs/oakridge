import { feedbackText, type GradingFeedback } from "../../lib/grading-config";
interface GradingConfigFeedbackProps { readonly feedback: GradingFeedback | null }
export function GradingConfigFeedback({ feedback }: GradingConfigFeedbackProps) {
  if (feedback === null) return null;
  return <div role="status" aria-live="polite" data-testid="grading-config-feedback" data-kind={feedback.kind} className="rounded border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3 break-words">
    <p>{feedbackText(feedback)}</p>
    {feedback.kind === "validation_failed" && <ul>{feedback.issues.map((issue, index) => <li key={index}>Definition {issue.definition_index ?? "configuration"} · {issue.path.join(".")}: {issue.detail}</li>)}</ul>}
  </div>;
}
