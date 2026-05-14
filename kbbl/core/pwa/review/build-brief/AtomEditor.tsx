import { useState } from "react";

interface Props {
  anchor: string;
  value: string;
  onSave: (newValue: string) => void;
  onCancel: () => void;
  saving: boolean;
}

function isListElementAnchor(anchor: string): boolean {
  // Matches active_subgoals[i], files_in_scope[i], open_questions[i]
  return /\[\d+\]$/.test(anchor);
}

export function AtomEditor({ anchor, value, onSave, onCancel, saving }: Props) {
  const [draft, setDraft] = useState(value);
  const singleLine = isListElementAnchor(anchor);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave(draft.trim());
    }
  }

  return (
    <div className="atom-editor">
      {singleLine ? (
        <input
          type="text"
          className="atom-editor-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
        />
      ) : (
        <textarea
          className="atom-editor-textarea"
          value={draft}
          autoFocus
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
        />
      )}
      <div className="atom-editor-actions">
        <button
          type="button"
          className="atom-editor-save"
          onClick={() => onSave(draft.trim())}
          disabled={saving}
        >
          {saving ? "saving…" : "save"}
        </button>
        <button
          type="button"
          className="atom-editor-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          cancel
        </button>
      </div>
    </div>
  );
}
