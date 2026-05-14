interface Props {
  anchor: string;
  threadCount: number;
  onNewThread: () => void;
}

export function AtomCommentAffordance({ anchor, threadCount, onNewThread }: Props) {
  return (
    <div className="atom-affordance">
      {threadCount > 0 && (
        <span className="atom-thread-badge" title={`${threadCount} thread${threadCount !== 1 ? "s" : ""}`}>
          {threadCount}
        </span>
      )}
      <button
        type="button"
        className="atom-new-thread"
        title="New thread on this atom"
        aria-label={`Start new thread for ${anchor}`}
        onClick={onNewThread}
      >
        +
      </button>
    </div>
  );
}
