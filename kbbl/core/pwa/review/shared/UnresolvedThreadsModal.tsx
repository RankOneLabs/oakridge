interface ReviewThread {
  id: string;
  author: string;
  firstLineSnippet: string;
  deepLinkPath: string;
}

interface UnresolvedThreadsModalProps {
  threads: ReviewThread[];
  prUrl: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnresolvedThreadsModal({
  threads,
  prUrl,
  pending,
  onConfirm,
  onCancel,
}: UnresolvedThreadsModalProps) {
  return (
    <div className="review-modal" onClick={onCancel}>
      <div
        className="review-modal__panel review-modal__panel--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-modal__title">Unresolved review threads</div>
        <div className="review-modal__thread-list">
          {threads.map((thread) => (
            <div key={thread.id} className="review-modal__thread-row">
              <span className="review-modal__thread-author">{thread.author}</span>
              <a
                href={prUrl + thread.deepLinkPath}
                target="_blank"
                rel="noopener"
                className="review-modal__thread-snippet"
              >
                {thread.firstLineSnippet}
              </a>
            </div>
          ))}
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
            {pending ? "Merging…" : "Merge with unresolved comments"}
          </button>
        </div>
      </div>
    </div>
  );
}
