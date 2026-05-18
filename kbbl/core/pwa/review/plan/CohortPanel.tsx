import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";
import type { AtomEdit, Thread, ReviewMode } from "../shared/types";
import { liveValueAt } from "../shared/liveness";
import type { Cohort } from "./types";

interface CohortPanelProps {
  cohort: Cohort;
  edits: AtomEdit[];
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  onOpenThread: (anchor: string) => void;
}

export function CohortPanel({
  cohort,
  edits,
  threads,
  mode,
  frozen,
  onOpenThread,
}: CohortPanelProps) {
  const titleAnchor = `cohorts[${cohort.position}].title`;
  const notesAnchor = `cohorts[${cohort.position}].notes`;

  const liveTitle = liveValueAt(edits, titleAnchor, cohort.title);
  const liveNotes = liveValueAt(edits, notesAnchor, cohort.notes ?? "");

  return (
    <div
      style={{
        padding: 16,
        borderLeft: "1px solid var(--border-subtle)",
        minWidth: 240,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>Cohort details</div>

      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.6 }}>Title</span>
          <AtomCommentAffordance
            anchor={titleAnchor}
            threads={threads}
            onOpenThread={onOpenThread}
            frozen={frozen || mode === "edit"}
          />
        </div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{liveTitle}</div>
      </div>

      <div>
        <span style={{ fontSize: 12, opacity: 0.6 }}>Status</span>
        <div
          style={{
            fontSize: 12,
            marginTop: 2,
            padding: "2px 6px",
            borderRadius: 3,
            background: "var(--bg-surface)",
            display: "inline-block",
          }}
        >
          {cohort.status}
        </div>
      </div>

      {(cohort.notes || liveNotes) && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 12, opacity: 0.6 }}>Notes</span>
            <AtomCommentAffordance
              anchor={notesAnchor}
              threads={threads}
              onOpenThread={onOpenThread}
              frozen={frozen || mode === "edit"}
            />
          </div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
            {liveNotes}
          </div>
        </div>
      )}
    </div>
  );
}
