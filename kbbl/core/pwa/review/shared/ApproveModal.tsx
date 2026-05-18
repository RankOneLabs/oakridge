interface ApproveModalProps {
  artifactId: string;
  subjectLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}

export function ApproveModal({
  artifactId,
  subjectLabel,
  onConfirm,
  onCancel,
  pending,
}: ApproveModalProps) {
  const subject = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);
  return (
    <div className="review-modal" onClick={onCancel}>
      <div
        className="review-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-modal__title">Approve {subjectLabel}?</div>
        <div className="review-modal__body">
          {subject} <code>{artifactId.slice(0, 8)}</code> will be approved and
          frozen.
        </div>
        <div className="review-modal__actions">
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="btn-approve"
          >
            {pending ? "Approving…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
