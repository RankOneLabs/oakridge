import type { ArtifactTarget, AtomEditRecord } from "./types";
import { filterHistoryByAnchor } from "./useArtifactStream";

interface Props {
  target: ArtifactTarget;
  anchor?: string | null;
  edits: AtomEditRecord[];
  onSelectThread?: (threadId: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function RevisionHistoryPanel({
  anchor = null,
  edits,
  onSelectThread,
  collapsed = false,
  onToggleCollapse,
}: Props) {
  const filtered = filterHistoryByAnchor(edits, anchor);

  if (collapsed) {
    return (
      <div className="revision-history revision-history--collapsed">
        <button type="button" className="revision-history-toggle" onClick={onToggleCollapse}>
          history ({filtered.length})
        </button>
      </div>
    );
  }

  return (
    <div className="revision-history">
      <div className="revision-history-header">
        <span className="revision-history-title">
          {anchor ? `history: ${anchor}` : "plan history"}
        </span>
        {onToggleCollapse && (
          <button type="button" className="revision-history-toggle" onClick={onToggleCollapse}>
            collapse
          </button>
        )}
      </div>
      <div className="revision-history-list">
        {filtered.length === 0 && (
          <div className="revision-history-empty">no edits yet</div>
        )}
        {filtered.map((edit) => (
          <div key={edit.id} className="revision-history-item">
            <div className="revision-history-item-meta">
              <span className="revision-history-anchor">{edit.anchor}</span>
              <span className="revision-history-by">{edit.edited_by}</span>
              <span className="revision-history-time">
                {new Date(edit.created_at).toLocaleString()}
              </span>
              {edit.thread_id && onSelectThread && (
                <button
                  type="button"
                  className="revision-history-thread-link"
                  onClick={() => onSelectThread(edit.thread_id!)}
                >
                  view thread
                </button>
              )}
            </div>
            <div className="revision-history-diff">
              {edit.prev_value !== null && (
                <div className="revision-history-prev">−{edit.prev_value}</div>
              )}
              <div className="revision-history-new">+{edit.new_value}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
