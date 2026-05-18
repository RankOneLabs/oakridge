import type { Thread } from "./types";

interface AtomCommentAffordanceProps {
  anchor: string;
  threads: Thread[];
  onOpenThread: (anchor: string) => void;
  frozen?: boolean;
}

export function AtomCommentAffordance({
  anchor,
  threads,
  onOpenThread,
  frozen,
}: AtomCommentAffordanceProps) {
  const openCount = threads.filter(
    (t) => t.anchor === anchor && t.status === "open",
  ).length;

  return (
    <button
      type="button"
      className={`review-shell__tap-target atom-comment-affordance${openCount > 0 ? " atom-comment-affordance--has-threads" : ""}`}
      disabled={!!frozen}
      onClick={() => onOpenThread(anchor)}
      title={`${openCount} comment${openCount !== 1 ? "s" : ""} on ${anchor}`}
    >
      {openCount > 0 ? openCount : "+"}
    </button>
  );
}
