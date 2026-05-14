import { useState } from "react";
import type { CommentThread, AtomEditRecord } from "../shared/types";
import type { DirectEditResult } from "../shared/useDirectEdit";

export interface CohortAtom {
  cohort_index: number;
  title: string;
  notes: string;
  priority: number;
}

interface Props {
  planId: string;
  cohort: CohortAtom | null;
  threads: CommentThread[];
  atomHistory: AtomEditRecord[];
  mode: "direct-edit" | "review";
  directEdit: DirectEditResult;
  atomMap: Record<string, string>;
  onOpenThread: (threadId: string) => void;
  onNewThread: (anchor: string) => void;
  onClose: () => void;
}

export function CohortPanel({
  planId: _planId,
  cohort,
  threads,
  atomHistory,
  mode,
  directEdit,
  atomMap,
  onOpenThread,
  onNewThread,
  onClose,
}: Props) {
  if (!cohort) return null;

  const prefix = `cohorts[${cohort.cohort_index}]`;
  const titleAnchor = `${prefix}.title`;
  const notesAnchor = `${prefix}.notes`;
  const priorityAnchor = `${prefix}.priority`;

  const cohortThreads = threads.filter((t) => t.anchor?.startsWith(prefix));

  return (
    <div className="cohort-panel">
      <div className="cohort-panel-header">
        <span className="cohort-panel-title">cohort #{cohort.cohort_index}</span>
        <button type="button" className="cohort-panel-close" onClick={onClose}>×</button>
      </div>

      <div className="cohort-panel-fields">
        <AtomField
          label="title"
          anchor={titleAnchor}
          currentValue={atomMap[titleAnchor] ?? cohort.title}
          readonly={mode === "review"}
          directEdit={directEdit}
          atomHistory={atomHistory}
        />
        <AtomField
          label="notes"
          anchor={notesAnchor}
          currentValue={atomMap[notesAnchor] ?? cohort.notes}
          readonly={mode === "review"}
          directEdit={directEdit}
          atomHistory={atomHistory}
          multiline
        />
        <AtomField
          label="priority"
          anchor={priorityAnchor}
          currentValue={atomMap[priorityAnchor] ?? String(cohort.priority)}
          readonly={mode === "review"}
          directEdit={directEdit}
          atomHistory={atomHistory}
          numeric
        />
      </div>

      {mode === "review" && (
        <div className="cohort-panel-threads">
          <div className="cohort-panel-threads-header">
            threads
            <button
              type="button"
              className="cohort-panel-new-thread"
              onClick={() => onNewThread(prefix)}
            >
              + new
            </button>
          </div>
          {cohortThreads.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`cohort-panel-thread-badge cohort-panel-thread-badge--${t.status}`}
              onClick={() => onOpenThread(t.id)}
            >
              {t.anchor ?? "plan"} · {t.status}
            </button>
          ))}
        </div>
      )}

      {directEdit.error && (
        <div className="cohort-panel-error">{directEdit.error}</div>
      )}
    </div>
  );
}

function AtomField({
  label,
  anchor,
  currentValue,
  readonly,
  directEdit,
  atomHistory: _atomHistory,
  multiline = false,
  numeric = false,
}: {
  label: string;
  anchor: string;
  currentValue: string;
  readonly: boolean;
  directEdit: DirectEditResult;
  atomHistory: AtomEditRecord[];
  multiline?: boolean;
  numeric?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentValue);
  const [optimistic, setOptimistic] = useState<string | null>(null);

  const displayed = optimistic ?? currentValue;

  async function handleSave() {
    const prev = currentValue;
    setOptimistic(draft);
    setEditing(false);
    const ok = await directEdit.save(anchor, prev, draft);
    setOptimistic(null);
    if (!ok) {
      setDraft(currentValue);
    }
  }

  if (readonly) {
    return (
      <div className="atom-field atom-field--readonly">
        <div className="atom-field-label">{label}</div>
        <div className="atom-field-value">{displayed}</div>
      </div>
    );
  }

  return (
    <div className="atom-field">
      <div className="atom-field-label">{label}</div>
      {editing ? (
        <div className="atom-field-edit">
          {multiline ? (
            <textarea
              className="atom-field-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
            />
          ) : (
            <input
              type={numeric ? "number" : "text"}
              className="atom-field-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          <button type="button" className="atom-field-save" onClick={() => void handleSave()} disabled={directEdit.saving}>
            save
          </button>
          <button type="button" className="atom-field-cancel" onClick={() => { setEditing(false); setDraft(currentValue); }}>
            cancel
          </button>
        </div>
      ) : (
        <button type="button" className="atom-field-display" onClick={() => { setEditing(true); setDraft(displayed); }}>
          <span className="atom-field-value">{displayed}</span>
          <span className="atom-field-edit-hint">edit</span>
        </button>
      )}
    </div>
  );
}
