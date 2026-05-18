import { useState } from "react";

interface RejectModalProps {
  artifactId: string;
  subjectLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  pending: boolean;
}

export function RejectModal({
  artifactId,
  subjectLabel,
  onConfirm,
  onCancel,
  pending,
}: RejectModalProps) {
  const [reason, setReason] = useState("");
  const subject = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);

  return (
    <div className="review-modal" onClick={onCancel}>
      <div
        className="review-modal__panel review-modal__panel--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-modal__title">Reject {subjectLabel}?</div>
        <div className="review-modal__body">
          {subject} <code>{artifactId.slice(0, 8)}</code> — provide a reason
          for the planner.
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection…"
          rows={4}
          className="review-modal__textarea"
          autoFocus
        />
        <div className="review-modal__actions">
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => reason.trim() && onConfirm(reason.trim())}
            disabled={pending || !reason.trim()}
            className="btn-deny"
          >
            {pending ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
