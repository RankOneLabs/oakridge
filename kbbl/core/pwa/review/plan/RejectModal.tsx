import { useState } from "react";

interface RejectModalProps {
  planId: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  pending: boolean;
}

export function RejectModal({
  planId,
  onConfirm,
  onCancel,
  pending,
}: RejectModalProps) {
  const [reason, setReason] = useState("");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "var(--surface-raised, #1e1e1e)",
          border: "1px solid var(--border, #444)",
          borderRadius: 8,
          padding: 24,
          minWidth: 360,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>Reject plan?</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Plan <code>{planId.slice(0, 8)}</code> — provide a reason for the
          planner.
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection…"
          rows={4}
          style={{ fontSize: 13, resize: "vertical", width: "100%", boxSizing: "border-box" }}
          autoFocus
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => reason.trim() && onConfirm(reason.trim())}
            disabled={pending || !reason.trim()}
            style={{
              background: "var(--danger, #7a2a2a)",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              borderRadius: 4,
              cursor:
                pending || !reason.trim() ? "default" : "pointer",
            }}
          >
            {pending ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
