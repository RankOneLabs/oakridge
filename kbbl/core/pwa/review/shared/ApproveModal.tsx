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
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          Approve {subjectLabel}?
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {subject} <code>{artifactId.slice(0, 8)}</code> will be approved and
          frozen.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
            className="review-shell__tap-target"
            onClick={onConfirm}
            disabled={pending}
            style={{
              background: "var(--success-fg)",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: pending ? "default" : "pointer",
            }}
          >
            {pending ? "Approving…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
