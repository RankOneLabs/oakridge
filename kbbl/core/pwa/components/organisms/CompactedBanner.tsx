import { useState, type Ref } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import { useSessionHandoff } from "../../hooks/useSessionHandoff";

export function CompactedBanner({
  ref,
  sid,
  successorSid,
  onOpenSuccessor,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  /**
   * Successor oakridgeSid surfaced from the snapshot. May be null when the
   * predecessor's compaction succeeded but the successor spawn or handoff
   * delivery failed (compact_succeeded_but_resume_failed) — the PWA still
   * shows the banner with the handoff body but the "open successor"
   * action is hidden.
   */
  successorSid: string | null;
  onOpenSuccessor: (nextSid: string) => void;
}) {
  // Default the handoff to expanded so an operator who taps a compacted
  // row lands directly on the rendered handoff (matches plan §1.8 "tap a
  // compacted session row → render handoff").
  const [showHandoff, setShowHandoff] = useState(true);
  const { handoff, status: handoffStatus } = useSessionHandoff(sid, showHandoff);

  return (
    <div className="compacted-banner" ref={ref}>
      <div className="compacted-banner__row">
        <span className="compacted-banner__label">Compacted</span>
        {successorSid !== null ? (
          <button
            type="button"
            className="btn-resume btn-resume-banner compacted-banner__open"
            onClick={() => onOpenSuccessor(successorSid)}
            title={`Open successor session ${successorSid}`}
          >
            → session {successorSid.slice(0, 8)}
          </button>
        ) : (
          <span
            className="compacted-banner__no-successor"
            title="The successor session never started — the handoff is below for review."
          >
            (no successor — resume failed)
          </span>
        )}
        <button
          type="button"
          className="compacted-banner__toggle"
          onClick={() => setShowHandoff((p) => !p)}
          aria-expanded={showHandoff}
        >
          {showHandoff ? "Hide handoff" : "Show handoff"}
        </button>
      </div>
      {showHandoff && (
        <div className="compacted-banner__handoff">
          {handoffStatus === "loading" && (
            <div className="compacted-banner__status">loading handoff…</div>
          )}
          {handoffStatus === "missing" && (
            <div className="compacted-banner__status">
              no handoff document on disk for this session
            </div>
          )}
          {handoffStatus === "error" && (
            <div className="compacted-banner__status">
              failed to load handoff
            </div>
          )}
          {handoffStatus === "ok" && handoff !== null && (
            <Markdown rehypePlugins={[rehypeSanitize]}>{handoff}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}
