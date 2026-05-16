import type { Thread } from "./types";

interface ThreadSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  onNewThread: () => void;
}

export function ThreadSidebar({
  threads,
  selectedThreadId,
  onSelect,
  onNewThread,
}: ThreadSidebarProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        minWidth: 180,
        borderLeft: "1px solid var(--border, #444)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Threads</span>
        <button type="button" onClick={onNewThread} style={{ fontSize: 12 }}>
          + New
        </button>
      </div>

      {threads.map((t) => {
        const isSelected = t.id === selectedThreadId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            style={{
              textAlign: "left",
              padding: "6px 8px",
              borderRadius: 4,
              background: isSelected
                ? "var(--accent-muted, #1a3a5c)"
                : "var(--surface-raised, #2a2a2a)",
              border: isSelected
                ? "1px solid var(--accent, #4a8fcb)"
                : "1px solid transparent",
              fontSize: 12,
              cursor: "pointer",
              width: "100%",
            }}
          >
            <div style={{ fontWeight: 500 }}>
              {t.anchor ?? "general"}
            </div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>{t.status}</div>
          </button>
        );
      })}

      {threads.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5 }}>No threads yet.</div>
      )}
    </div>
  );
}
