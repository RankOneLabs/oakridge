import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { AssessmentAdjudication } from "../../hooks/useAssessmentAdjudication";
import { NO_REVIEW_REASON, selectAdjudicationBlockReason, selectAdjudicationDecisions, selectDecisionButtonLabel, selectRecordedDecisionSummary } from "../../lib/assessment-adjudication";

interface Props { adjudication: AssessmentAdjudication }

/** The open review’s adjudication decisions. */
export function AssessmentDecisionBar({ adjudication }: Props) {
  const { gate, state, isOpen, isPending, recordedDecision, isRecorded } = adjudication;
  if (!isOpen) {
    const status = recordedDecision ? selectRecordedDecisionSummary(recordedDecision) : isRecorded ? "Decision submitted. Waiting for it to be recorded." : NO_REVIEW_REASON;
    return <section aria-label="Assessment decision" className="rounded-md border border-[var(--border-decorative)] p-3"><FeedbackMessage>{status}</FeedbackMessage></section>;
  }
  return <section aria-label="Assessment decision" className="flex flex-col gap-3 rounded-md border border-[var(--accent-primary)] p-3" data-testid="or-assessment-decision-bar">
    <div className="flex flex-wrap items-start gap-3">
      {selectAdjudicationDecisions(gate).map(declared => {
        const reason = selectAdjudicationBlockReason(state, gate, declared);
        return <div key={declared.definition.key} className="flex max-w-xs flex-col gap-1">
          <Button variant={declared.role === "feedback" ? "primary" : "secondary"} disabled={isPending || reason !== null} title={reason ?? undefined}
            onClick={() => adjudication.submit(declared)}>{selectDecisionButtonLabel(state, declared)}</Button>
          {reason && <span className="text-xs text-[var(--text-muted)]">{reason}</span>}
        </div>;
      })}
    </div>
    {adjudication.error && <FeedbackMessage tone="danger">{adjudication.error.message}</FeedbackMessage>}
  </section>;
}
