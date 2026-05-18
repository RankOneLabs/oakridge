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
    <div className="thread-sidebar">
      <div className="thread-sidebar__header">
        <span>Threads</span>
        <button
          type="button"
          className="review-shell__tap-target thread-sidebar__new"
          onClick={onNewThread}
        >
          + New
        </button>
      </div>

      {threads.map((t) => {
        const isSelected = t.id === selectedThreadId;
        return (
          <button
            key={t.id}
            type="button"
            className={`review-shell__tap-target thread-sidebar__row${isSelected ? " thread-sidebar__row--selected" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="thread-sidebar__row-anchor">
              {t.anchor ?? "general"}
            </div>
            <div className="thread-sidebar__row-status">{t.status}</div>
          </button>
        );
      })}

      {threads.length === 0 && (
        <div className="thread-sidebar__empty">No threads yet.</div>
      )}
    </div>
  );
}
