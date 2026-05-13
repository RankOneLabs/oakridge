import { createPortal } from "react-dom";
import type { CommentThread } from "../shared/types";

interface Props {
  threads: CommentThread[];
  onConfirm: () => void;
  onClose: () => void;
  acting: boolean;
}

export function ApproveModal({ threads, onConfirm, onClose, acting }: Props) {
  const openCount = threads.filter((t) => t.status === "open").length;

  return createPortal(
    <div className="modal-overlay" onClick={acting ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Approve plan" onClick={(e) => e.stopPropagation()}>
        <h2>Approve plan?</h2>
        {openCount > 0 && (
          <p className="modal-warning">
            {openCount} open thread{openCount !== 1 ? "s" : ""} — approve anyway?
          </p>
        )}
        <p>This will materialize the plan cohorts as tasks.</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={acting}>cancel</button>
          <button type="button" className="modal-confirm modal-confirm--approve" onClick={onConfirm} disabled={acting}>
            {acting ? "approving…" : "approve"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
