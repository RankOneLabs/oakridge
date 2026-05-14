import type { CommentThread } from "./types";

interface Props {
  threads: CommentThread[];
  selectedThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewThread: (anchor: string | null) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function ThreadSidebar({
  threads,
  selectedThreadId,
  onSelect,
  onNewThread,
  collapsed = false,
  onToggleCollapse,
}: Props) {
  if (collapsed) {
    return (
      <div className="thread-sidebar thread-sidebar--collapsed">
        <button type="button" className="thread-sidebar-toggle" onClick={onToggleCollapse}>
          threads ({threads.length})
        </button>
      </div>
    );
  }

  const planThreads = threads.filter((t) => t.anchor === null);
  const atomThreads = threads.filter((t) => t.anchor !== null);

  return (
    <div className="thread-sidebar">
      <div className="thread-sidebar-header">
        <span className="thread-sidebar-title">threads</span>
        {onToggleCollapse && (
          <button type="button" className="thread-sidebar-toggle" onClick={onToggleCollapse}>
            collapse
          </button>
        )}
      </div>

      <div className="thread-sidebar-group">
        <div className="thread-sidebar-group-label">plan</div>
        {planThreads.map((t) => (
          <ThreadListItem key={t.id} thread={t} selected={selectedThreadId === t.id} onSelect={onSelect} />
        ))}
        <button
          type="button"
          className="thread-sidebar-new"
          onClick={() => onNewThread(null)}
        >
          + new plan thread
        </button>
      </div>

      {atomThreads.length > 0 && (
        <div className="thread-sidebar-group">
          <div className="thread-sidebar-group-label">anchors</div>
          {atomThreads.map((t) => (
            <ThreadListItem key={t.id} thread={t} selected={selectedThreadId === t.id} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadListItem({
  thread,
  selected,
  onSelect,
}: {
  thread: CommentThread;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`thread-list-item${selected ? " thread-list-item--selected" : ""}`}
      onClick={() => onSelect(thread.id)}
    >
      <span className="thread-list-anchor">{thread.anchor ?? "plan"}</span>
      <span className={`thread-list-badge thread-list-badge--${thread.status}`}>{thread.status}</span>
      {thread.agent_responding === 1 && (
        <span className="thread-list-responding">thinking…</span>
      )}
    </button>
  );
}
