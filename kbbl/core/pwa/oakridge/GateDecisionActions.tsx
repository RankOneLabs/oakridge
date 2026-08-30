import { useEffect, useRef, useState } from "react";

import { useResumeGate } from "./hooks/useResumeGate";
import type { ParkedGate } from "./types";
import { randomUuid } from "../lib/random-uuid";

interface GateDecisionActionsProps {
  gate: ParkedGate;
  artifactRevisionId?: string;
  actionLabels?: Record<string, string>;
  onComplete?: () => void;
}

function actionLabel(action: string): string {
  switch (action) {
    case "approve": return "Approve artifact";
    case "request_revision": return "Request changes";
    case "confirm_merged": return "Confirm merge";
    case "pass": return "Pass";
    case "fail": return "Mark failed";
    case "rerun": return "Run again";
    default: return action.replaceAll("_", " ");
  }
}

function successMessage(action: string): string {
  if (action === "request_revision") return "Changes requested. The cohort will return to its build step.";
  if (action === "confirm_merged") return "Merge confirmed. The cohort can continue.";
  return "Decision recorded. The cohort can continue.";
}

export function GateDecisionActions(props: GateDecisionActionsProps) {
  return <GateDecisionActionsForGate key={props.gate.id} {...props} />;
}

function GateDecisionActionsForGate({ gate, artifactRevisionId, actionLabels = {}, onComplete }: GateDecisionActionsProps) {
  const mutation = useResumeGate(gate.id, gate.run_id);
  const [feedbackAction, setFeedbackAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [completedAction, setCompletedAction] = useState<string | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const isActive = useRef(true);
  // A gate stays listed whatever its run's state (spec §1 rule 9); it is only
  // actionable while the run is still active. `disabled` on every button is
  // what keeps the feedback textarea from ever opening too — a disabled
  // native button never fires its onClick.
  const disabled = !gate.actionable;

  useEffect(() => {
    return () => { isActive.current = false; };
  }, []);

  const submit = (action: string, decisionFeedback?: string) => {
    const decisionRevisionId = artifactRevisionId ?? gate.artifact_revision_id;
    if (!decisionRevisionId) return;
    const feedbackValue = decisionFeedback?.trim() ?? "";
    const gateStep = gate.gate_step ?? gate.gate_type;
    const operatorComment = actionLabels[action] ?? actionLabel(action);
    const requestIdentity = JSON.stringify({
      action,
      artifact_revision_id: decisionRevisionId,
      feedback: feedbackValue,
      gate_step: gateStep,
      operator_comment: operatorComment,
    });
    let key = requestKeys.current.get(requestIdentity);
    if (!key) {
      key = randomUuid();
      requestKeys.current.set(requestIdentity, key);
    }
    mutation.mutate({
      idempotency_key: key,
      artifact_revision_id: decisionRevisionId,
      gate_step: gateStep,
      action,
      operator_comment: operatorComment,
      feedback: feedbackValue,
    }, {
      onSuccess: () => {
        if (!isActive.current) return;
        setCompletedAction(action);
        setFeedbackAction(null);
        onComplete?.();
      },
    });
  };

  if (completedAction) {
    return <div className="or-decision-success" role="status" data-testid="or-decision-success">{successMessage(completedAction)}</div>;
  }

  return (
    <div className="or-decision-actions" data-testid="or-decision-actions">
      {disabled && (
        <div className="or-decision-actions__stranded" role="status" data-testid="or-gate-stranded">
          Run {gate.run_state} — gate stranded
        </div>
      )}
      <div className="or-decision-actions__buttons">
        {gate.resume_actions.map((action) => {
          const needsFeedback = action === "request_revision" || action === "rerun" || action === "reject" || action === "fail";
          const isPrimary = action === "approve" || action === "confirm_merged" || action === "pass";
          return (
            <button
              key={action}
              type="button"
              className={isPrimary ? "or-decision-button or-decision-button--primary" : "or-decision-button or-decision-button--secondary"}
              disabled={mutation.isPending || disabled}
              onClick={() => needsFeedback ? setFeedbackAction(action) : submit(action)}
              data-testid={`or-decision-${action}`}
            >
              {mutation.isPending && mutation.variables?.action === action ? "Saving…" : (actionLabels[action] ?? actionLabel(action))}
            </button>
          );
        })}
      </div>

      {feedbackAction && (
        <div className="or-decision-feedback" data-testid="or-decision-feedback">
          <label htmlFor={`or-decision-feedback-${gate.id}`}>What needs to change?</label>
          <textarea
            id={`or-decision-feedback-${gate.id}`}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={4}
            autoFocus
            placeholder="Give the builder specific, actionable feedback."
          />
          <div className="or-decision-feedback__buttons">
            <button type="button" className="or-decision-button or-decision-button--secondary" onClick={() => setFeedbackAction(null)}>Cancel</button>
            <button type="button" className="or-decision-button or-decision-button--danger" disabled={!feedback.trim() || mutation.isPending} onClick={() => submit(feedbackAction, feedback)}>Send feedback</button>
          </div>
        </div>
      )}

      {mutation.isError && <div className="or-decision-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Could not save the decision."}</div>}
    </div>
  );
}
