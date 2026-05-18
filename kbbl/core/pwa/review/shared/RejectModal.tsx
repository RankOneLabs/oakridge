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
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          padding: 24,
          minWidth: 360,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          Reject {subjectLabel}?
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {subject} <code>{artifactId.slice(0, 8)}</code> — provide a reason
          for the planner.
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
              background: "var(--danger-fg)",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              borderRadius: 4,
              cursor: pending || !reason.trim() ? "default" : "pointer",
            }}
          >
            {pending ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
