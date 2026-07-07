import { useState } from "react";
import { useResumeGate } from "./hooks";
import type { ParkedGate } from "./types";

interface GateResumeFormProps {
  gate: ParkedGate;
  onDone: () => void;
}

export function GateResumeForm({ gate, onDone }: GateResumeFormProps) {
  const [action, setAction] = useState<string>(gate.resume_actions[0] ?? "");
  const [operatorComment, setOperatorComment] = useState("");
  const [feedback, setFeedback] = useState("");

  const mutation = useResumeGate(gate.id, gate.run_id);

  const hasActions = gate.resume_actions.length > 0;
  const canSubmit = hasActions && action !== "" && operatorComment.trim() !== "" && !mutation.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { action, operator_comment: operatorComment.trim(), feedback: feedback.trim() },
      { onSuccess: onDone },
    );
  };

  return (
    <form
      className="or-resume-form"
      onSubmit={onSubmit}
      data-testid="or-resume-form"
      aria-label="Resume gate"
    >
      <h3 className="or-resume-form__title">Resume gate</h3>

      {!hasActions && (
        <div className="or-resume-form__no-actions or-muted" data-testid="or-resume-no-actions">
          No resume actions are available for this gate.
        </div>
      )}

      {gate.resume_actions.length > 1 && (
        <div className="or-resume-form__field">
          <label className="or-label" htmlFor="or-resume-action">Action</label>
          <select
            id="or-resume-action"
            className="or-select"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            data-testid="or-resume-action"
          >
            {gate.resume_actions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      )}

      {gate.resume_actions.length === 1 && (
        <div className="or-resume-form__field">
          <span className="or-label">Action</span>
          <span className="or-chip or-chip--action" data-testid="or-resume-action-static">{action}</span>
        </div>
      )}

      <div className="or-resume-form__field">
        <label className="or-label" htmlFor="or-resume-comment">
          Operator comment <span className="or-required">(required)</span>
        </label>
        <textarea
          id="or-resume-comment"
          className="or-textarea"
          value={operatorComment}
          onChange={(e) => setOperatorComment(e.target.value)}
          placeholder="Why are you resuming this gate?"
          rows={3}
          required
          data-testid="or-resume-comment"
        />
      </div>

      <div className="or-resume-form__field">
        <label className="or-label" htmlFor="or-resume-feedback">
          Feedback <span className="or-optional">(optional)</span>
        </label>
        <textarea
          id="or-resume-feedback"
          className="or-textarea"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Additional feedback for the agent"
          rows={4}
          data-testid="or-resume-feedback"
        />
      </div>

      {mutation.isError && (
        <div className="or-error" role="alert" data-testid="or-resume-error">
          {mutation.error instanceof Error ? mutation.error.message : "Resume failed"}
        </div>
      )}

      <div className="or-resume-form__actions">
        <button
          type="button"
          className="or-btn or-btn--secondary"
          onClick={onDone}
          disabled={mutation.isPending}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="or-btn or-btn--primary"
          disabled={!canSubmit}
          data-testid="or-resume-submit"
        >
          {mutation.isPending ? "Resuming…" : "Resume"}
        </button>
      </div>
    </form>
  );
}
