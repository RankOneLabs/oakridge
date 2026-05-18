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
  bodyClassName?: string;
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
  bodyClassName,
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

  const displayClass = [
    "structured-doc__field-display",
    mode === "edit" && !frozen ? "structured-doc__field-display--editable" : "",
    bodyClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="structured-doc__atom">
      {label && (
        <div className="structured-doc__atom-label">{label}</div>
      )}
      <div className="structured-doc__atom-row">
        {editing ? (
          <>
            {multiline ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="structured-doc__textarea"
                autoFocus
                onBlur={commitEdit}
              />
            ) : (
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="structured-doc__input"
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
          >
            {value || <span className="structured-doc__placeholder">—</span>}
          </button>
        ) : (
          <div
            className={displayClass}
          >
            {value || <span className="structured-doc__placeholder">—</span>}
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

function BriefGoalField(props: Omit<AtomFieldProps, "bodyClassName">) {
  return (
    <div className="brief-section">
      <div className="brief-section-label">Goal</div>
      <AtomField {...props} bodyClassName="brief-hero" multiline />
    </div>
  );
}

function BriefDecisionCard({
  item,
  idx,
  sharedProps,
}: {
  item: { decision: string; rationale: string };
  idx: number;
  sharedProps: Omit<AtomFieldProps, "anchor" | "value" | "bodyClassName">;
}) {
  const rationaleAnchor = `decisions_made[${idx}].rationale`;
  return (
    <div className="brief-decision-card">
      <div className="brief-decision-card__header">{item.decision}</div>
      <div className="brief-decision-card__rationale-label">Rationale</div>
      <AtomField
        anchor={rationaleAnchor}
        value={liveValueAt(sharedProps.edits, rationaleAnchor, item.rationale)}
        bodyClassName="brief-decision-card__rationale-body"
        multiline
        {...sharedProps}
      />
    </div>
  );
}

function BriefApproachRejectedCard({
  item,
  idx,
  sharedProps,
}: {
  item: { approach: string; reason: string };
  idx: number;
  sharedProps: Omit<AtomFieldProps, "anchor" | "value" | "bodyClassName">;
}) {
  const reasonAnchor = `approaches_rejected[${idx}].reason`;
  return (
    <div className="brief-approach-rejected">
      <div className="brief-approach-rejected__header">{item.approach}</div>
      <div className="brief-approach-rejected__reason-label">Reason</div>
      <AtomField
        anchor={reasonAnchor}
        value={liveValueAt(sharedProps.edits, reasonAnchor, item.reason)}
        bodyClassName="brief-approach-rejected__reason-body"
        multiline
        {...sharedProps}
      />
    </div>
  );
}

function BriefNextActionField(props: Omit<AtomFieldProps, "bodyClassName">) {
  return (
    <div className="brief-section">
      <div className="brief-section-label">Next action</div>
      <AtomField {...props} bodyClassName="brief-next-action" multiline />
    </div>
  );
}

function BriefAtomListItem({
  anchor,
  value,
  sharedProps,
}: {
  anchor: string;
  value: string;
  sharedProps: Omit<AtomFieldProps, "anchor" | "value" | "bodyClassName">;
}) {
  return (
    <li className="brief-atom-list__item">
      <AtomField anchor={anchor} value={value} {...sharedProps} />
    </li>
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
    <div className="structured-doc">
      <BriefGoalField
        anchor="goal"
        value={liveGoal}
        {...sharedProps}
      />

      <div className="brief-section">
        <div className="brief-section-label">Files in scope</div>
        {brief.files_in_scope.length > 0 ? (
          <ul className="brief-atom-list">
            {brief.files_in_scope.map((file, idx) => {
              const anchor = `files_in_scope[${idx}]`;
              return (
                <BriefAtomListItem
                  key={anchor}
                  anchor={anchor}
                  value={liveValueAt(edits, anchor, file)}
                  sharedProps={sharedProps}
                />
              );
            })}
          </ul>
        ) : (
          <div className="brief-empty">None listed.</div>
        )}
      </div>

      <div className="brief-section">
        <div className="brief-section-label">Decisions made</div>
        {brief.decisions_made.length > 0 ? (
          brief.decisions_made.map((d, idx) => (
            <BriefDecisionCard
              key={idx}
              item={d}
              idx={idx}
              sharedProps={sharedProps}
            />
          ))
        ) : (
          <div className="brief-empty">None listed.</div>
        )}
      </div>

      <div className="brief-section">
        <div className="brief-section-label">Approaches rejected</div>
        {brief.approaches_rejected.length > 0 ? (
          brief.approaches_rejected.map((a, idx) => (
            <BriefApproachRejectedCard
              key={idx}
              item={a}
              idx={idx}
              sharedProps={sharedProps}
            />
          ))
        ) : (
          <div className="brief-empty">None listed.</div>
        )}
      </div>

      <BriefNextActionField
        anchor="next_action"
        value={liveNextAction}
        {...sharedProps}
      />
    </div>
  );
}
