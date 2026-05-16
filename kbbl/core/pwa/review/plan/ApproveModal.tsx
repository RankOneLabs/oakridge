interface ApproveModalProps {
  planId: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}

export function ApproveModal({
  planId,
  onConfirm,
  onCancel,
  pending,
}: ApproveModalProps) {
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
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>Approve plan?</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Plan <code>{planId.slice(0, 8)}</code> will be approved and frozen.
          Leaf cohorts will be promoted to planned.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            style={{
              background: "var(--success, #2a7a2a)",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
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
