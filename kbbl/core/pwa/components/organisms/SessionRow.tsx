import { useState, useEffect } from "react";

import type { SessionSnapshot } from "../../types";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { prettyModelLabel } from "../../lib/format";
import { resumeTitle } from "../../lib/session";

export function SessionRow({
  snapshot,
  onOpen,
  onResume,
  resumeDisabled,
}: {
  snapshot: SessionSnapshot;
  onOpen: () => void;
  onResume: () => void;
  resumeDisabled: boolean;
}) {
  const relative = useRelativeTime(snapshot.lastActivityTs);
  const canResume = snapshot.status === "ended";
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Auto-clear the confirm-pending state after a few seconds so a stray
  // first tap doesn't leave a primed Remove button waiting indefinitely.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  async function remove() {
    if (removing) return;
    setRemoving(true);
    try {
      await fetch(`/sessions/${encodeURIComponent(snapshot.sid)}?purge=true`, {
        method: "DELETE",
      });
      // Server broadcasts session_removed; the inbox handler drops the row.
      // No optimistic UI here — if the request failed silently the row
      // simply stays put and the operator can retry.
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <li className="session-row-li">
      <button
        type="button"
        className={`session-row session-row-${snapshot.status}`}
        onClick={onOpen}
      >
        <div className="session-row-line">
          <span className={`session-row-status session-row-status-${snapshot.status}`}>
            {snapshot.status === "compacting" ? "compacting…" : snapshot.status}
          </span>
          <span className="session-row-name" title={snapshot.sid}>
            {snapshot.name || snapshot.sid.slice(0, 8)}
          </span>
          {snapshot.model && (
            <span className="session-row-model" title={snapshot.model}>
              {prettyModelLabel(snapshot.model)}
            </span>
          )}
          {snapshot.pendingCount > 0 && (
            <span className="session-row-pending" aria-label={`${snapshot.pendingCount} pending approvals`}>
              {snapshot.pendingCount} pending
            </span>
          )}
          {snapshot.yoloMode && (
            <span className="session-row-yolo">YOLO</span>
          )}
          <span className="session-row-activity">{relative}</span>
        </div>
        <div className="session-row-workdir" title={snapshot.workdir}>
          {snapshot.workdir}
        </div>
        {snapshot.endReason === "compacted" && snapshot.successorSid && (
          <div
            className="session-row-successor"
            title={`Continued in successor session ${snapshot.successorSid}`}
          >
            → {snapshot.successorSid.slice(0, 8)}
          </div>
        )}
      </button>
      {canResume && (
        <button
          type="button"
          className="btn-resume"
          disabled={resumeDisabled}
          title={resumeTitle(snapshot.lastResultUsage)}
          onClick={(e) => {
            // Don't also trigger the row's open-transcript click behind us.
            e.stopPropagation();
            onResume();
          }}
        >
          Resume
        </button>
      )}
      <button
        type="button"
        className={`btn-remove${confirmRemove ? " is-confirming" : ""}`}
        disabled={removing}
        title={
          snapshot.status === "live"
            ? "Aborts the live subprocess and deletes the transcript file."
            : "Deletes the transcript file."
        }
        onClick={(e) => {
          e.stopPropagation();
          if (!confirmRemove) {
            setConfirmRemove(true);
            return;
          }
          void remove();
        }}
      >
        {removing
          ? "removing…"
          : confirmRemove
            ? "tap to confirm"
            : "Remove"}
      </button>
    </li>
  );
}
