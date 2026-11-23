import { BLOCKER_REVIEW } from "../../operator-contracts/constants";
import { TextArea } from "../../../components/atoms/TextArea";
import { useEffect, useRef, useState } from "react";

import { useResumeGate } from "../../hooks/useResumeGate";
import { useRunGates } from "../../hooks/useRunGates";
import type { MergeStatus, ParkedGate } from "../../artifact-types";
import { fetchMergeStatus } from "../../client";
import { randomUuid } from "../../../lib/random-uuid";
import { selectInboxDecisionGate } from "../../lib/review-decision-selectors";
import { selectGateDecision } from "../../adapters/core";
import { Button } from "../../../components/atoms/Button";
import { selectValidationRejectionNotice } from "../../lib/validation-rejection";

const decisionButtonClass = "min-h-12 w-full rounded-lg! px-4! py-[0.65rem]! md:min-h-11 md:w-auto";

interface GateDecisionActionsProps {
  gate: ParkedGate;
  artifactRevisionId?: string;
  onComplete?: () => void;
}

function successMessage(gate: ParkedGate, action: string): string {
  const recipients = gate.producer_labels?.join(", ") || "the worker";
  if (gate.gate_step === BLOCKER_REVIEW) return `Answer sent to ${recipients}.`;
  if (gate.gate_type === "merge") return "Merge confirmed.";
  const decision = selectGateDecision(gate, action);
  return decision?.submit.kind === "review" && decision.submit.effect === "request_changes"
    ? `Changes requested from ${recipients}.` : "Decision recorded.";
}

function mergeWarning(status: Exclude<MergeStatus, { readonly kind: "merged" }>): string {
  if (status.kind === "unavailable") return `Could not verify the PR merge: ${status.detail}`;
  return status.state === "open" ? "The PR is still open according to the live status."
    : "The PR is closed without a merge according to the live status.";
}

export function GateDecisionActions(props: GateDecisionActionsProps) {
  // An adjudicating inbox item links to the assessment. Its plain decisions
  // use the full gate's target and fields.
  if (!props.gate.decision_definitions && props.gate.resume_actions.length > 0)
    return <InboxGateDecisionActions {...props} />;
  return <GateDecisionActionsForGate key={props.gate.id} {...props} />;
}

function InboxGateDecisionActions({ gate, ...props }: GateDecisionActionsProps) {
  const query = useRunGates(gate.run_id);
  const fullGate = selectInboxDecisionGate(gate, query.data ?? []);
  if (!fullGate) return <p role="status">{query.isPending ? "Loading review decisions…" : "Review decisions unavailable."}</p>;
  return <GateDecisionActionsForGate {...props} key={fullGate.id} gate={fullGate} artifactRevisionId={undefined} />;
}

function GateDecisionActionsForGate({ gate, artifactRevisionId, onComplete }: GateDecisionActionsProps) {
  const mutation = useResumeGate(gate.id, gate.run_id);
  const [feedbackAction, setFeedbackAction] = useState<string | null>(null);
  // An approval starts the next worker and cannot be taken back, so the first
  // click turns the Approve button into Confirm and only the second submits.
  const [confirmingAction, setConfirmingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [completedAction, setCompletedAction] = useState<string | null>(null);
  const [completedWithOverride, setCompletedWithOverride] = useState(false);
  const [isCheckingMerge, setIsCheckingMerge] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<Exclude<MergeStatus, { readonly kind: "merged" }> | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const isActive = useRef(true);
  // A gate stays listed whatever its run's state (spec §1 rule 9); it is only
  // actionable while the run is still active. `disabled` on every button is
  // what keeps the feedback textarea from ever opening too — a disabled
  // native button never fires its onClick.
  const disabled = !gate.actionable;
  const mergeAction = gate.gate_type === "merge" ? gate.resume_actions.find((action) => {
    const submit = selectGateDecision(gate, action)?.submit;
    return submit?.kind === "review" && submit.effect === "approve";
  }) : undefined;
  const feedbackDecision = selectGateDecision(gate, feedbackAction);
  const isBlocker = gate.gate_step === BLOCKER_REVIEW;

  useEffect(() => {
    return () => { isActive.current = false; };
  }, []);

  const submit = (action: string, decisionFeedback?: string, isOverride = false) => {
    if (disabled || selectGateDecision(gate, action)?.is_available === false) return;
    const decisionRevisionId = artifactRevisionId ?? gate.artifact_revision_id;
    if (!decisionRevisionId) return;
    const feedbackValue = decisionFeedback?.trim() ?? "";
    const requestIdentity = JSON.stringify({
      action,
      artifact_revision_id: decisionRevisionId,
      feedback: feedbackValue,
    });
    let key = requestKeys.current.get(requestIdentity);
    if (!key) {
      key = randomUuid();
      requestKeys.current.set(requestIdentity, key);
    }
    mutation.mutate({
      idempotency_key: key,
      artifact_revision_id: decisionRevisionId,
      action,
      feedback: feedbackValue,
    }, {
      onSuccess: () => {
        if (!isActive.current) return;
        setCompletedAction(action);
        setCompletedWithOverride(isOverride);
        setFeedbackAction(null);
        setConfirmingAction(null);
        onComplete?.();
      },
    });
  };

  const choose = (action: string, needsFeedback: boolean, isPrimary: boolean) => {
    if (action === mergeAction) { void checkAndConfirmMerge(action); return; }
    if (isPrimary && !needsFeedback) {
      setFeedbackAction(null);
      if (confirmingAction === action) submit(action);
      else setConfirmingAction(action);
      return;
    }
    setConfirmingAction(null);
    if (needsFeedback) setFeedbackAction(action);
    else submit(action);
  };

  const checkAndConfirmMerge = async (action: string) => {
    setMergeStatus(null);
    setIsCheckingMerge(true);
    try {
      const status = await fetchMergeStatus(gate.id);
      if (!isActive.current) return;
      if (status.kind === "merged") submit(action);
      else setMergeStatus(status);
    } catch (cause) {
      if (isActive.current) setMergeStatus({ kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (isActive.current) setIsCheckingMerge(false);
    }
  };

  if (completedAction) {
    return <div className="or-decision-success" role="status" data-testid="or-decision-success">
      {completedWithOverride ? "Merge confirmation recorded with an operator override. The run can continue." : successMessage(gate, completedAction)}
    </div>;
  }

  return (
    <div className="or-decision-actions" data-testid="or-decision-actions">
      {gate.requires_adjudication && gate.validation_rejection && <p role="status" className="or-gate-validation-notice text-sm text-[var(--danger-fg)]" data-testid="or-gate-validation-rejection">{selectValidationRejectionNotice(gate.validation_rejection)}</p>}
      {gate.requires_adjudication && gate.resume_actions.length === 0 && <p>Review and adjudicate the actions in the assessment to record a decision.</p>}
      {disabled && (
        <div className="or-decision-actions__stranded" role="status" data-testid="or-gate-stranded">
          Run {gate.run_state} — gate stranded
        </div>
      )}
      <div className="or-decision-actions__buttons">
        {gate.resume_actions.map((action) => {
          const decision = selectGateDecision(gate, action);
          const needsFeedback = Boolean(decision?.fields.length);
          const isPrimary = decision?.submit.kind === "review" && decision.submit.effect === "approve";
          const isConfirming = action === confirmingAction;
          const isUnavailable = decision?.is_available === false;
          const reason = isUnavailable ? decision.disabled_reason : null;
          const reasonId = `or-decision-disabled-${gate.id}-${action}`;
          return (
            <div key={action} className="flex flex-col gap-1">
              <Button
                variant={isPrimary ? "primary" : "secondary"}
                className={`${decisionButtonClass} ${isPrimary ? "" : "text-[var(--text-primary)]!"}`}
                disabled={mutation.isPending || isCheckingMerge || disabled || isUnavailable}
                aria-describedby={reason ? reasonId : undefined}
                onClick={() => choose(action, needsFeedback, isPrimary)}
                onBlur={isConfirming && !mutation.isPending ? () => setConfirmingAction(null) : undefined}
                data-testid={`or-decision-${action}`}
              >
                {isCheckingMerge && action === mergeAction ? "Checking PR…" : mutation.isPending && mutation.variables?.action === action
                  ? "Saving…" : isConfirming ? "Confirm approval" : (decision?.label ?? action.replaceAll("_", " "))}
              </Button>
              {reason && <p id={reasonId} className="text-sm text-[var(--text-secondary)]" role="status">{reason}</p>}
            </div>
          );
        })}
      </div>

      {mergeStatus && mergeAction && !disabled && selectGateDecision(gate, mergeAction)?.is_available !== false && (
        <div className="or-decision-feedback" role="alert" data-testid="or-merge-warning">
          <p>{mergeWarning(mergeStatus)}</p>
          {gate.pr_url && <p>Pull request: <a href={gate.pr_url} target="_blank" rel="noopener noreferrer">{gate.pr_url}</a></p>}
          <p>Confirm anyway only if you have verified the intended PR merged.</p>
          <div className="or-decision-feedback__buttons">
            <Button variant="secondary" className={`${decisionButtonClass} text-[var(--text-primary)]!`}
              onClick={() => setMergeStatus(null)}>Cancel</Button>
            <Button variant="danger" className={`${decisionButtonClass} border-transparent! bg-[var(--danger-fg)]! text-[var(--bg-app)]!`}
              disabled={mutation.isPending} onClick={() => submit(mergeAction, undefined, true)}>Confirm anyway</Button>
          </div>
        </div>
      )}

      {feedbackAction && !disabled && feedbackDecision?.is_available !== false && (
        <div className="or-decision-feedback" data-testid="or-decision-feedback">
          <label htmlFor={`or-decision-feedback-${gate.id}`}>{isBlocker ? feedbackDecision?.fields[0]?.label ?? "Answer" : "What needs to change?"}</label>
          <TextArea
            id={`or-decision-feedback-${gate.id}`}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={4}
            autoFocus
            placeholder={isBlocker ? "Answer the worker’s question." : "Describe the changes needed."}
          />
          <div className="or-decision-feedback__buttons">
            <Button variant="secondary" className={`${decisionButtonClass} text-[var(--text-primary)]!`} onClick={() => setFeedbackAction(null)}>Cancel</Button>
            <Button variant="danger" className={`${decisionButtonClass} border-transparent! bg-[var(--danger-fg)]! text-[var(--bg-app)]!`} disabled={disabled || !feedback.trim() || mutation.isPending} onClick={() => submit(feedbackAction, feedback)}>{isBlocker ? "Send answer" : "Send feedback"}</Button>
          </div>
        </div>
      )}

      {mutation.isError && <div className="or-decision-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Could not save the decision."}</div>}
    </div>
  );
}
