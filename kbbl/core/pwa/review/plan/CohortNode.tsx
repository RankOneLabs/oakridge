import { Handle, Position } from "reactflow";
import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";
import type { Thread, ReviewMode } from "../shared/types";
import type { Cohort } from "./types";

export interface CohortNodeData {
  cohort: Cohort;
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  onSelectCohort: (id: string) => void;
  onOpenThread: (anchor: string) => void;
  isSelected: boolean;
}

export function CohortNode({ data }: { data: CohortNodeData }) {
  const { cohort, threads, mode, frozen, onSelectCohort, onOpenThread, isSelected } =
    data;

  const titleAnchor = `cohorts[${cohort.position}].title`;
  const notesAnchor = `cohorts[${cohort.position}].notes`;

  return (
    <div
      onClick={() => onSelectCohort(cohort.id)}
      style={{
        padding: "12px 14px",
        border: `1px solid ${isSelected ? "var(--accent-blue)" : "var(--border-subtle)"}`,
        borderRadius: 4,
        background: "var(--bg-elevated)",
        minWidth: 200,
        minHeight: 64,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--border-subtle)" }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 4,
          marginBottom: cohort.notes ? 4 : 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
          {cohort.title}
        </span>
        <AtomCommentAffordance
          anchor={titleAnchor}
          threads={threads}
          onOpenThread={onOpenThread}
          frozen={frozen || mode === "edit"}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            background: "var(--bg-surface)",
            opacity: 0.8,
          }}
        >
          {cohort.status}
        </span>

        {cohort.notes && (
          <AtomCommentAffordance
            anchor={notesAnchor}
            threads={threads}
            onOpenThread={onOpenThread}
            frozen={frozen || mode === "edit"}
          />
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--border-subtle)" }}
      />
    </div>
  );
}
