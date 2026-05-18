import { useState } from "react";
import { liveValueAt } from "../shared/liveness";
import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";
import type { AtomEdit, Thread, ReviewMode } from "../shared/types";
import type { Brief } from "./types";

interface AtomFieldProps {
  anchor: string;
  value: string;
  label?: string;
  edits: AtomEdit[];
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  onEdit: (anchor: string, prevValue: string | null, newValue: string) => void;
  onOpenThread: (anchor: string) => void;
  multiline?: boolean;
}

function AtomField({
  anchor,
  value,
  label,
  threads,
  mode,
  frozen,
  onEdit,
  onOpenThread,
  multiline,
}: AtomFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function startEdit() {
    setDraft(value);
    setEditing(true);
  }

  function commitEdit() {
    if (draft !== value) {
      onEdit(anchor, value, draft);
    }
    setEditing(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {label && (
        <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 500 }}>
          {label}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
        {editing ? (
          <>
            {multiline ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{
                  flex: 1,
                  fontSize: 13,
                  resize: "vertical",
                  minHeight: 60,
                }}
                autoFocus
                onBlur={commitEdit}
              />
            ) : (
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ flex: 1, fontSize: 13 }}
                autoFocus
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
            )}
          </>
        ) : mode === "edit" && !frozen ? (
          <button
            type="button"
            className="review-shell__tap-target structured-doc__edit-trigger"
            onClick={startEdit}
            style={{
              flex: 1,
              fontSize: 13,
              background: "var(--bg-surface)",
              whiteSpace: "pre-wrap",
            }}
          >
            {value || <span style={{ opacity: 0.4 }}>—</span>}
          </button>
        ) : (
          <div
            style={{
              flex: 1,
              fontSize: 13,
              padding: "2px 4px",
              borderRadius: 3,
              whiteSpace: "pre-wrap",
              minHeight: 20,
            }}
          >
            {value || <span style={{ opacity: 0.4 }}>—</span>}
          </div>
        )}
        {!editing && (
          <AtomCommentAffordance
            anchor={anchor}
            threads={threads}
            onOpenThread={onOpenThread}
            frozen={frozen}
          />
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13, opacity: 0.7 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

interface StructuredDocEditorProps {
  brief: Brief;
  edits: AtomEdit[];
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  onEdit: (
    anchor: string,
    prevValue: string | null,
    newValue: string,
  ) => void;
  onOpenThread: (anchor: string) => void;
}

export function StructuredDocEditor({
  brief,
  edits,
  threads,
  mode,
  frozen,
  onEdit,
  onOpenThread,
}: StructuredDocEditorProps) {
  const sharedProps = { edits, threads, mode, frozen, onEdit, onOpenThread };

  const liveGoal = liveValueAt(edits, "goal", brief.goal);
  const liveNextAction = liveValueAt(edits, "next_action", brief.next_action);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Section label="Goal">
        <AtomField
          anchor="goal"
          value={liveGoal}
          multiline
          {...sharedProps}
        />
      </Section>

      <Section label="Files in scope">
        {brief.files_in_scope.map((file, idx) => {
          const anchor = `files_in_scope[${idx}]`;
          return (
            <AtomField
              key={anchor}
              anchor={anchor}
              value={liveValueAt(edits, anchor, file)}
              {...sharedProps}
            />
          );
        })}
        {brief.files_in_scope.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.4 }}>None listed.</div>
        )}
      </Section>

      <Section label="Decisions made">
        {brief.decisions_made.map((d, idx) => {
          const rationaleAnchor = `decisions_made[${idx}].rationale`;
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "6px 8px",
                borderRadius: 4,
                background: "var(--bg-elevated)",
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 500 }}>Decision</div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{d.decision}</div>
              <AtomField
                anchor={rationaleAnchor}
                value={liveValueAt(edits, rationaleAnchor, d.rationale)}
                label="Rationale"
                multiline
                {...sharedProps}
              />
            </div>
          );
        })}
        {brief.decisions_made.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.4 }}>None listed.</div>
        )}
      </Section>

      <Section label="Approaches rejected">
        {brief.approaches_rejected.map((a, idx) => {
          const reasonAnchor = `approaches_rejected[${idx}].reason`;
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "6px 8px",
                borderRadius: 4,
                background: "var(--bg-elevated)",
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 500 }}>Approach</div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{a.approach}</div>
              <AtomField
                anchor={reasonAnchor}
                value={liveValueAt(edits, reasonAnchor, a.reason)}
                label="Reason"
                multiline
                {...sharedProps}
              />
            </div>
          );
        })}
        {brief.approaches_rejected.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.4 }}>None listed.</div>
        )}
      </Section>

      <Section label="Next action">
        <AtomField
          anchor="next_action"
          value={liveNextAction}
          multiline
          {...sharedProps}
        />
      </Section>
    </div>
  );
}
