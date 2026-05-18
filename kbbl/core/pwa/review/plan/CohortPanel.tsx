import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";
import type { AtomEdit, Thread, ReviewMode } from "../shared/types";
import { liveValueAt } from "../shared/liveness";
import type { Cohort } from "./types";

function ThreadListItem({
  thread,
  onOpen,
}: {
  thread: Thread;
  onOpen: (anchor: string) => void;
}) {
  return (
    <button
      type="button"
      className="cohort-detail__thread-row review-shell__tap-target"
      onClick={() => onOpen(thread.anchor ?? "")}
    >
      <span>{thread.anchor ?? "general"}</span>
      <span style={{ opacity: 0.6 }}>{thread.status}</span>
    </button>
  );
}

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

  const cohortThreads = threads.filter(
    (t) => t.anchor?.startsWith(`cohorts[${cohort.position}]`) ?? false,
  );

  return (
    <div className="cohort-detail">
      <div className="cohort-detail__title-row">
        <h2 className="cohort-detail__title">{liveTitle}</h2>
        <AtomCommentAffordance
          anchor={titleAnchor}
          threads={threads}
          onOpenThread={onOpenThread}
          frozen={frozen || mode === "edit"}
        />
      </div>

      <div className="cohort-detail__label-value">
        <div className="cohort-detail__label">Status</div>
        <div className="cohort-detail__status">{cohort.status}</div>
      </div>

      {(cohort.notes || liveNotes) && (
        <div className="cohort-detail__label-value">
          <div className="cohort-detail__label">
            Notes
            <AtomCommentAffordance
              anchor={notesAnchor}
              threads={threads}
              onOpenThread={onOpenThread}
              frozen={frozen || mode === "edit"}
            />
          </div>
          <div className="cohort-detail__notes">{liveNotes}</div>
        </div>
      )}

      {cohortThreads.length > 0 && (
        <div className="cohort-detail__label-value">
          <div className="cohort-detail__label">Threads</div>
          <div className="cohort-detail__threads">
            {cohortThreads.map((t) => (
              <ThreadListItem key={t.id} thread={t} onOpen={onOpenThread} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
