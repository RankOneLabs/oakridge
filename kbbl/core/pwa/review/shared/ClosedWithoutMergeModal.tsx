interface ClosedWithoutMergeModalProps {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ClosedWithoutMergeModal({
  pending,
  onConfirm,
  onCancel,
}: ClosedWithoutMergeModalProps) {
  return (
    <div className="review-modal" onClick={onCancel}>
      <div
        className="review-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-modal__title">PR closed without merging</div>
        <div className="review-modal__body">
          This PR was closed without merging. Mark cohort done anyway?
        </div>
        <div className="review-modal__actions">
          <button
            type="button"
            className="review-shell__tap-target"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-approve review-shell__tap-target"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Marking done…" : "Mark done"}
          </button>
        </div>
      </div>
    </div>
  );
}
