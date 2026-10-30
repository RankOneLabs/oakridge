import { useEffect, useRef, useState } from "react";

import { useResumeGate } from "../../hooks/useResumeGate";
import type { MergeStatus, ParkedGate } from "../../types";
import { fetchMergeStatus } from "../../client";
import { randomUuid } from "../../../lib/random-uuid";
import { Button } from "../../../components/atoms/Button";

const decisionButtonClass = "min-h-12 w-full rounded-lg! px-4! py-[0.65rem]! md:min-h-11 md:w-auto";

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
    case "request_assessment_changes": return "Request assessment changes";
    case "request_build_changes": return "Request build changes";
    case "confirm_merged": return "Confirm merge";
    case "pass": return "Pass";
    case "fail": return "Mark failed";
    case "rerun": return "Run again";
    default: return action.replaceAll("_", " ");
  }
}

function successMessage(action: string): string {
  if (action === "request_assessment_changes") return "Assessment changes requested. The assessor will revise its report.";
  if (action === "request_build_changes") return "Build changes requested. The builder will revise its work.";
  if (action === "request_revision") return "Changes requested.";
  if (action === "confirm_merged") return "Merge confirmed. The cohort can continue.";
  return "Decision recorded. The cohort can continue.";
}

function mergeWarning(status: Exclude<MergeStatus, { readonly kind: "merged" }>): string {
  if (status.kind === "unavailable") return `Could not verify the PR merge: ${status.detail}`;
  return status.state === "open" ? "The PR is still open according to the live status."
    : "The PR is closed without a merge according to the live status.";
}

export function GateDecisionActions(props: GateDecisionActionsProps) {
  return <GateDecisionActionsForGate key={props.gate.id} {...props} />;
}

function GateDecisionActionsForGate({ gate, artifactRevisionId, actionLabels = {}, onComplete }: GateDecisionActionsProps) {
  const mutation = useResumeGate(gate.id, gate.run_id);
  const [feedbackAction, setFeedbackAction] = useState<string | null>(null);
  // An approval starts the next worker and cannot be taken back, so the first
  // click turns the Approve button into Confirm and only the second submits.
  const [isConfirmingApproval, setIsConfirmingApproval] = useState(false);
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

  useEffect(() => {
    return () => { isActive.current = false; };
  }, []);

  const submit = (action: string, decisionFeedback?: string, isOverride = false) => {
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
        setCompletedWithOverride(isOverride);
        setFeedbackAction(null);
        setIsConfirmingApproval(false);
        onComplete?.();
      },
    });
  };

  const choose = (action: string, needsFeedback: boolean) => {
    if (action === "approve") {
      setFeedbackAction(null);
      if (isConfirmingApproval) submit("approve");
      else setIsConfirmingApproval(true);
      return;
    }
    setIsConfirmingApproval(false);
    if (needsFeedback) setFeedbackAction(action);
    else if (action === "confirm_merged") void checkAndConfirmMerge();
    else submit(action);
  };

  const checkAndConfirmMerge = async () => {
    setMergeStatus(null);
    setIsCheckingMerge(true);
    try {
      const status = await fetchMergeStatus(gate.id);
      if (!isActive.current) return;
      if (status.kind === "merged") submit("confirm_merged");
      else setMergeStatus(status);
    } catch (cause) {
      if (isActive.current) setMergeStatus({ kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (isActive.current) setIsCheckingMerge(false);
    }
  };

  if (completedAction) {
    return <div className="or-decision-success" role="status" data-testid="or-decision-success">
      {completedWithOverride ? "Merge confirmation recorded with an operator override. The run can continue." : successMessage(completedAction)}
    </div>;
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
          const needsFeedback = action === "request_revision" || action === "request_assessment_changes" || action === "request_build_changes"
            || action === "rerun" || action === "reject" || action === "fail";
          const isPrimary = action === "approve" || action === "confirm_merged" || action === "pass";
          const isConfirming = action === "approve" && isConfirmingApproval;
          return (
            <Button
              key={action}
              variant={isPrimary ? "primary" : "secondary"}
              className={`${decisionButtonClass} ${isPrimary ? "text-white!" : "text-[var(--text-primary)]!"}`}
              disabled={mutation.isPending || isCheckingMerge || disabled}
              onClick={() => choose(action, needsFeedback)}
              onBlur={isConfirming && !mutation.isPending ? () => setIsConfirmingApproval(false) : undefined}
              data-testid={`or-decision-${action}`}
            >
              {isCheckingMerge && action === "confirm_merged" ? "Checking PR…" : mutation.isPending && mutation.variables?.action === action
                ? "Saving…" : isConfirming ? "Confirm approval" : (actionLabels[action] ?? actionLabel(action))}
            </Button>
          );
        })}
      </div>

      {mergeStatus && !disabled && (
        <div className="or-decision-feedback" role="alert" data-testid="or-merge-warning">
          <p>{mergeWarning(mergeStatus)}</p>
          {gate.pr_url && <p>Pull request: <a href={gate.pr_url} target="_blank" rel="noopener noreferrer">{gate.pr_url}</a></p>}
          <p>Confirm anyway only if you have verified the intended PR merged.</p>
          <div className="or-decision-feedback__buttons">
            <Button variant="secondary" className={`${decisionButtonClass} text-[var(--text-primary)]!`}
              onClick={() => setMergeStatus(null)}>Cancel</Button>
            <Button variant="danger" className={`${decisionButtonClass} border-transparent! bg-[var(--danger-fg)]! text-white!`}
              disabled={mutation.isPending} onClick={() => submit("confirm_merged", undefined, true)}>Confirm anyway</Button>
          </div>
        </div>
      )}

      {feedbackAction && !disabled && (
        <div className="or-decision-feedback" data-testid="or-decision-feedback">
          <label htmlFor={`or-decision-feedback-${gate.id}`}>What needs to change?</label>
          <textarea
            id={`or-decision-feedback-${gate.id}`}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={4}
            autoFocus
            placeholder="Describe the changes needed."
          />
          <div className="or-decision-feedback__buttons">
            <Button variant="secondary" className={`${decisionButtonClass} text-[var(--text-primary)]!`} onClick={() => setFeedbackAction(null)}>Cancel</Button>
            <Button variant="danger" className={`${decisionButtonClass} border-transparent! bg-[var(--danger-fg)]! text-white!`} disabled={disabled || !feedback.trim() || mutation.isPending} onClick={() => submit(feedbackAction, feedback)}>Send feedback</Button>
          </div>
        </div>
      )}

      {mutation.isError && <div className="or-decision-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Could not save the decision."}</div>}
    </div>
  );
}
