import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  onConfirm: (reason: string) => void;
  onClose: () => void;
  acting: boolean;
}

export function RejectModal({ onConfirm, onClose, acting }: Props) {
  const [reason, setReason] = useState("");

  return createPortal(
    <div className="modal-overlay" onClick={acting ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Reject plan" onClick={(e) => e.stopPropagation()}>
        <h2>Reject plan?</h2>
        <label>
          Rejection reason
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="Explain why this plan is rejected…"
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={acting}>cancel</button>
          <button
            type="button"
            className="modal-confirm modal-confirm--reject"
            onClick={() => onConfirm(reason.trim() || "operator rejected")}
            disabled={acting}
          >
            {acting ? "rejecting…" : "reject"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
