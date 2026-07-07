interface ThreadsUnknownModalProps {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ThreadsUnknownModal({ pending, onConfirm, onCancel }: ThreadsUnknownModalProps) {
  return (
    <div className="review-modal" onClick={onCancel}>
      <div
        className="review-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-modal__title">Review thread state unknown</div>
        <div className="review-modal__body">
          Review thread state could not be fetched from GitHub. Unresolved
          comments may exist. Confirm to merge anyway.
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
            {pending ? "Merging…" : "Merge with unknown thread state"}
          </button>
        </div>
      </div>
    </div>
  );
}
