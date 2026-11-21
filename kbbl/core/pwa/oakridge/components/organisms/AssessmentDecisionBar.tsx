import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { TextArea } from "../../../components/atoms/TextArea";
import type { AssessmentAdjudication } from "../../hooks/useAssessmentAdjudication";
import { selectValidationRejectionNotice } from "../../lib/validation-rejection";
import { NO_REVIEW_REASON, selectAdjudicationBlockReason, selectAdjudicationDecisions, selectAssessmentChangeDecision, selectDecisionButtonLabel, selectRecordedDecisionSummary } from "../../lib/assessment-adjudication";

interface Props { adjudication: AssessmentAdjudication }

/** Every decision the open review takes, in one place above the assessment: send back, accept, or ask the assessor to revise. */
export function AssessmentDecisionBar({ adjudication }: Props) {
  const [isRevising, setIsRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const { gate, state, isOpen, isPending, recordedDecision, isRecorded, validationRejection } = adjudication;
  if (!isOpen) {
    const status = recordedDecision ? selectRecordedDecisionSummary(recordedDecision) : isRecorded ? "Decision submitted. Waiting for it to be recorded." : NO_REVIEW_REASON;
    return <section aria-label="Assessment decision" className="rounded-md border border-[var(--border-decorative)] p-3"><FeedbackMessage>{status}</FeedbackMessage></section>;
  }
  const assessmentChange = selectAssessmentChangeDecision(gate);
  return <section aria-label="Assessment decision" className="flex flex-col gap-3 rounded-md border border-[var(--accent-primary)] p-3" data-testid="or-assessment-decision-bar">
    {validationRejection && <p role="status" className="text-sm text-[var(--danger-fg)]" data-testid="or-assessment-validation-rejection">
      {selectValidationRejectionNotice(validationRejection)}{assessmentChange ? ` ${assessmentChange.label} to have the assessor correct it.` : ""}
    </p>}
    <div className="flex flex-wrap items-start gap-3">
      {selectAdjudicationDecisions(gate).map(declared => {
        const reason = selectAdjudicationBlockReason(state, gate, declared);
        return <div key={declared.definition.key} className="flex max-w-xs flex-col gap-1">
          <Button variant={declared.effect === "request_changes" ? "primary" : "secondary"} disabled={isPending || reason !== null} title={reason ?? undefined}
            onClick={() => adjudication.submit(declared)}>{selectDecisionButtonLabel(state, declared)}</Button>
          {reason && <span className="text-xs text-[var(--text-muted)]">{reason}</span>}
        </div>;
      })}
      {assessmentChange && !isRevising && <Button variant="secondary" disabled={isPending} onClick={() => setIsRevising(true)}>{assessmentChange.label}…</Button>}
    </div>
    {assessmentChange && isRevising && <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">{assessmentChange.fields.find(field => field.key === "feedback")?.label ?? "What must the assessment change?"}
        <TextArea aria-label="Assessment feedback" value={feedback} disabled={isPending} onChange={event => setFeedback(event.target.value)} /></label>
      <div className="flex gap-2">
        <Button variant="primary" disabled={isPending || !feedback.trim()} onClick={() => adjudication.requestAssessmentChanges(assessmentChange, feedback)}>{assessmentChange.label}</Button>
        <Button variant="secondary" onClick={() => setIsRevising(false)}>Cancel</Button>
      </div>
    </div>}
    {adjudication.error && <FeedbackMessage tone="danger">{adjudication.error.message}</FeedbackMessage>}
  </section>;
}
