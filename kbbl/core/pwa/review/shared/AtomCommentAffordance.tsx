import type { Thread } from "./types";

interface AtomCommentAffordanceProps {
  anchor: string;
  threads: Thread[];
  onOpenThread: (anchor: string) => void;
  frozen?: boolean;
}

export function AtomCommentAffordance({
  anchor,
  threads,
  onOpenThread,
  frozen,
}: AtomCommentAffordanceProps) {
  const openCount = threads.filter(
    (t) => t.anchor === anchor && t.status === "open",
  ).length;

  return (
    <button
      type="button"
      onClick={() => onOpenThread(anchor)}
      title={`${openCount} comment${openCount !== 1 ? "s" : ""} on ${anchor}`}
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        background:
          openCount > 0 ? "var(--accent-muted, #1a3a5c)" : "transparent",
        border: "1px solid var(--border, #444)",
        cursor: frozen ? "default" : "pointer",
        opacity: frozen ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {openCount > 0 ? openCount : "+"}
    </button>
  );
}
