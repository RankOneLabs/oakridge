import { Button } from "../../components/atoms/Button";
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
        <Button variant="secondary"
          type="button"
          className="review-shell__tap-target thread-sidebar__new"
          onClick={onNewThread}
        >
          + New
        </Button>
      </div>

      {threads.map((t) => {
        const isSelected = t.id === selectedThreadId;
        return (
          <Button variant="secondary"
            key={t.id}
            type="button"
            className={`review-shell__tap-target thread-sidebar__row${isSelected ? " thread-sidebar__row--selected" : ""} flex-col items-stretch! gap-0!`}
            onClick={() => onSelect(t.id)}
          >
            <div className="thread-sidebar__row-anchor">
              {t.anchor ?? "general"}
            </div>
            <div className="thread-sidebar__row-status">{t.status}</div>
          </Button>
        );
      })}

      {threads.length === 0 && (
        <div className="thread-sidebar__empty">No threads yet.</div>
      )}
    </div>
  );
}
