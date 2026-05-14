import type { CommentThread } from "../shared/types";
import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";

export interface BriefField {
  anchor: string;
  value: string;
}

export interface BuildBriefRendererProps {
  atomMap: Record<string, string>;
  threads: CommentThread[];
  mode: "direct-edit" | "review";
  onAtomClick: (anchor: string) => void;
  onNewThread: (anchor: string) => void;
  onAddListItem: (field: string) => void;
  onDeleteListItem: (field: string, index: number) => void;
  editingAnchor: string | null;
  renderAtomEditor: (anchor: string, value: string) => React.ReactNode;
}

function threadCount(threads: CommentThread[], anchor: string): number {
  return threads.filter((t) => t.anchor === anchor).length;
}

interface AtomRowProps {
  anchor: string;
  value: string;
  mode: "direct-edit" | "review";
  threads: CommentThread[];
  editingAnchor: string | null;
  onAtomClick: (anchor: string) => void;
  onNewThread: (anchor: string) => void;
  renderAtomEditor: (anchor: string, value: string) => React.ReactNode;
  children?: React.ReactNode;
}

function AtomRow({
  anchor,
  value,
  mode,
  threads,
  editingAnchor,
  onAtomClick,
  onNewThread,
  renderAtomEditor,
}: AtomRowProps) {
  const isEditing = mode === "direct-edit" && editingAnchor === anchor;

  return (
    <div className="brief-atom-row">
      {isEditing ? (
        renderAtomEditor(anchor, value)
      ) : (
        <div
          className={`brief-atom-value${mode === "direct-edit" ? " brief-atom-value--editable" : ""}`}
          onClick={mode === "direct-edit" ? () => onAtomClick(anchor) : undefined}
        >
          {value || <span className="brief-atom-empty">(empty)</span>}
        </div>
      )}
      {mode === "review" && (
        <AtomCommentAffordance
          anchor={anchor}
          threadCount={threadCount(threads, anchor)}
          onNewThread={() => onNewThread(anchor)}
        />
      )}
    </div>
  );
}

export function BuildBriefRenderer({
  atomMap,
  threads,
  mode,
  onAtomClick,
  onNewThread,
  onAddListItem,
  onDeleteListItem,
  editingAnchor,
  renderAtomEditor,
}: BuildBriefRendererProps) {
  const av = (anchor: string) => atomMap[anchor] ?? "";

  // Derive list lengths from atom_map keys
  const listLength = (prefix: string) => {
    const indices = Object.keys(atomMap)
      .filter((k) => k.startsWith(`${prefix}[`))
      .map((k) => {
        const m = k.match(/\[(\d+)\]/);
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((n) => n >= 0);
    return indices.length > 0 ? Math.max(...indices) + 1 : 0;
  };

  // Bump length by one when editingAnchor refers to a not-yet-persisted new item.
  const extendedLength = (prefix: string) => {
    const base = listLength(prefix);
    if (!editingAnchor || !editingAnchor.startsWith(`${prefix}[`)) return base;
    const m = editingAnchor.match(/\[(\d+)\]/);
    if (!m) return base;
    return Math.max(base, parseInt(m[1], 10) + 1);
  };

  const nSubgoals = extendedLength("active_subgoals");
  const nDecisions = extendedLength("decisions_made");
  const nRejected = extendedLength("approaches_rejected");
  const nFiles = extendedLength("files_in_scope");
  const nQuestions = extendedLength("open_questions");

  return (
    <div className="brief-renderer">
      {/* Goal */}
      <section className="brief-section">
        <h3 className="brief-section-title">Goal</h3>
        <AtomRow
          anchor="goal"
          value={av("goal")}
          mode={mode}
          threads={threads}
          editingAnchor={editingAnchor}
          onAtomClick={onAtomClick}
          onNewThread={onNewThread}
          renderAtomEditor={renderAtomEditor}
        />
      </section>

      {/* Next action */}
      <section className="brief-section">
        <h3 className="brief-section-title">Next action</h3>
        <AtomRow
          anchor="next_action"
          value={av("next_action")}
          mode={mode}
          threads={threads}
          editingAnchor={editingAnchor}
          onAtomClick={onAtomClick}
          onNewThread={onNewThread}
          renderAtomEditor={renderAtomEditor}
        />
      </section>

      {/* Active subgoals */}
      <section className="brief-section">
        <h3 className="brief-section-title">Active subgoals</h3>
        <ol className="brief-list">
          {Array.from({ length: nSubgoals }, (_, i) => {
            const anchor = `active_subgoals[${i}]`;
            return (
              <li key={anchor} className="brief-list-item">
                <AtomRow
                  anchor={anchor}
                  value={av(anchor)}
                  mode={mode}
                  threads={threads}
                  editingAnchor={editingAnchor}
                  onAtomClick={onAtomClick}
                  onNewThread={onNewThread}
                  renderAtomEditor={renderAtomEditor}
                />
                {mode === "direct-edit" && (
                  <button
                    type="button"
                    className="brief-list-delete"
                    onClick={() => onDeleteListItem("active_subgoals", i)}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        {mode === "direct-edit" && (
          <button
            type="button"
            className="brief-list-add"
            onClick={() => onAddListItem("active_subgoals")}
          >
            + add subgoal
          </button>
        )}
      </section>

      {/* Decisions made */}
      <section className="brief-section">
        <h3 className="brief-section-title">Decisions made</h3>
        <div className="brief-cards">
          {Array.from({ length: nDecisions }, (_, i) => {
            const decisionAnchor = `decisions_made[${i}].decision`;
            const rationaleAnchor = `decisions_made[${i}].rationale`;
            return (
              <div key={i} className="brief-card">
                <div className="brief-card-field">
                  <span className="brief-card-label">decision</span>
                  <AtomRow
                    anchor={decisionAnchor}
                    value={av(decisionAnchor)}
                    mode={mode}
                    threads={threads}
                    editingAnchor={editingAnchor}
                    onAtomClick={onAtomClick}
                    onNewThread={onNewThread}
                    renderAtomEditor={renderAtomEditor}
                  />
                </div>
                <div className="brief-card-field">
                  <span className="brief-card-label">rationale</span>
                  <AtomRow
                    anchor={rationaleAnchor}
                    value={av(rationaleAnchor)}
                    mode={mode}
                    threads={threads}
                    editingAnchor={editingAnchor}
                    onAtomClick={onAtomClick}
                    onNewThread={onNewThread}
                    renderAtomEditor={renderAtomEditor}
                  />
                </div>
                {mode === "direct-edit" && (
                  <button
                    type="button"
                    className="brief-list-delete"
                    onClick={() => onDeleteListItem("decisions_made", i)}
                  >
                    × remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {mode === "direct-edit" && (
          <button
            type="button"
            className="brief-list-add"
            onClick={() => onAddListItem("decisions_made")}
          >
            + add decision
          </button>
        )}
      </section>

      {/* Approaches rejected */}
      <section className="brief-section">
        <h3 className="brief-section-title">Approaches rejected</h3>
        <div className="brief-cards">
          {Array.from({ length: nRejected }, (_, i) => {
            const approachAnchor = `approaches_rejected[${i}].approach`;
            const reasonAnchor = `approaches_rejected[${i}].reason`;
            return (
              <div key={i} className="brief-card">
                <div className="brief-card-field">
                  <span className="brief-card-label">approach</span>
                  <AtomRow
                    anchor={approachAnchor}
                    value={av(approachAnchor)}
                    mode={mode}
                    threads={threads}
                    editingAnchor={editingAnchor}
                    onAtomClick={onAtomClick}
                    onNewThread={onNewThread}
                    renderAtomEditor={renderAtomEditor}
                  />
                </div>
                <div className="brief-card-field">
                  <span className="brief-card-label">reason</span>
                  <AtomRow
                    anchor={reasonAnchor}
                    value={av(reasonAnchor)}
                    mode={mode}
                    threads={threads}
                    editingAnchor={editingAnchor}
                    onAtomClick={onAtomClick}
                    onNewThread={onNewThread}
                    renderAtomEditor={renderAtomEditor}
                  />
                </div>
                {mode === "direct-edit" && (
                  <button
                    type="button"
                    className="brief-list-delete"
                    onClick={() => onDeleteListItem("approaches_rejected", i)}
                  >
                    × remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {mode === "direct-edit" && (
          <button
            type="button"
            className="brief-list-add"
            onClick={() => onAddListItem("approaches_rejected")}
          >
            + add rejected approach
          </button>
        )}
      </section>

      {/* Files in scope */}
      <section className="brief-section">
        <h3 className="brief-section-title">Files in scope</h3>
        <ul className="brief-list brief-list--mono">
          {Array.from({ length: nFiles }, (_, i) => {
            const anchor = `files_in_scope[${i}]`;
            return (
              <li key={anchor} className="brief-list-item">
                <AtomRow
                  anchor={anchor}
                  value={av(anchor)}
                  mode={mode}
                  threads={threads}
                  editingAnchor={editingAnchor}
                  onAtomClick={onAtomClick}
                  onNewThread={onNewThread}
                  renderAtomEditor={renderAtomEditor}
                />
                {mode === "direct-edit" && (
                  <button
                    type="button"
                    className="brief-list-delete"
                    onClick={() => onDeleteListItem("files_in_scope", i)}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {mode === "direct-edit" && (
          <button
            type="button"
            className="brief-list-add"
            onClick={() => onAddListItem("files_in_scope")}
          >
            + add file
          </button>
        )}
      </section>

      {/* Open questions */}
      <section className="brief-section">
        <h3 className="brief-section-title">Open questions</h3>
        <ul className="brief-list">
          {Array.from({ length: nQuestions }, (_, i) => {
            const anchor = `open_questions[${i}]`;
            return (
              <li key={anchor} className="brief-list-item">
                <AtomRow
                  anchor={anchor}
                  value={av(anchor)}
                  mode={mode}
                  threads={threads}
                  editingAnchor={editingAnchor}
                  onAtomClick={onAtomClick}
                  onNewThread={onNewThread}
                  renderAtomEditor={renderAtomEditor}
                />
                {mode === "direct-edit" && (
                  <button
                    type="button"
                    className="brief-list-delete"
                    onClick={() => onDeleteListItem("open_questions", i)}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {mode === "direct-edit" && (
          <button
            type="button"
            className="brief-list-add"
            onClick={() => onAddListItem("open_questions")}
          >
            + add question
          </button>
        )}
      </section>
    </div>
  );
}
