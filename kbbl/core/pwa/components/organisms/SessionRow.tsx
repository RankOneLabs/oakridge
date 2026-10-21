import { useEffect, useState } from "react";

import type { SessionSnapshot } from "../../types";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { useEndSession } from "../../hooks/useEndSession";
import { prettyEffortLabel, prettyModelLabel } from "../../lib/format";
import { resumeTitle } from "../../lib/session";
import { Button } from "../atoms/Button";

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
  // Resume = a new session inheriting this closed one's worktree.
  const canResume =
    (snapshot.status === "ended" ||
      snapshot.status === "fenced" ||
      snapshot.status === "failed");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const { mutation: endMutation, error: endError } = useEndSession(snapshot.sid);

  // A stray first tap should not leave End armed indefinitely.
  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  // The rejection is swallowed because the failure is already rendered from
  // mutation state; letting it escape only produced an unhandled rejection on
  // a path that is in fact handled.
  async function end() {
    if (endMutation.isPending) return;
    try {
      await endMutation.mutateAsync();
    } catch {
      // Rendered below via endMutation.isError.
    } finally {
      setConfirmEnd(false);
    }
  }

  const canEnd = snapshot.source === "acp";
  const isTerminal = snapshot.status === "ended" || snapshot.status === "fenced" || snapshot.status === "failed";
  const actionLabel = isTerminal ? "Hide session" : "End and hide session";

  return (
    <li className="session-row-li">
      {/* Anchors the absolutely-positioned Resume/End buttons to the row
          itself, so a refusal rendered underneath doesn't drag them off
          centre. */}
      <div className="session-row-main">
        <button
          type="button"
          className={`session-row session-row-${snapshot.status}`}
          onClick={onOpen}
        >
          <div className="session-row-line">
            <span className={`session-row-status session-row-status-${snapshot.status}`}>
              {snapshot.status}
            </span>
            {snapshot.workflow && (
              <span className="session-row-role" title={`worker: ${snapshot.workflow.worker}`}>
                {snapshot.workflow.worker}
              </span>
            )}
            <span className="session-row-name" title={snapshot.sid}>
              {snapshot.name || snapshot.sid.slice(0, 8)}
            </span>
            <span className="session-row-model" title={`agent: ${snapshot.agentProfile}`}>
              {snapshot.agentProfile}
            </span>
            {snapshot.requestedModel && (
              <span
                className="session-row-model"
                title={`requested: ${snapshot.requestedModel}`}
              >
                {prettyModelLabel(snapshot.requestedModel)}
              </span>
            )}
            {snapshot.requestedEffort && (
              <span
                className="session-row-effort"
                title={`effort: ${snapshot.requestedEffort}`}
              >
                effort {prettyEffortLabel(snapshot.requestedEffort)}
              </span>
            )}
            {snapshot.pendingPermissionCount > 0 && (
              <span
                className="session-row-pending"
                aria-label={`${snapshot.pendingPermissionCount} pending permissions`}
              >
                {snapshot.pendingPermissionCount} pending
              </span>
            )}
            <span className="session-row-activity">{relative}</span>
          </div>
          <div className="session-row-workdir" title={snapshot.worktreePath}>
            {snapshot.projectWorkdir}
          </div>
        </button>
        {canResume && (
          <Button
            type="button"
            variant="primary"
            className="absolute right-[6.25rem] top-1/2 min-h-11 -translate-y-1/2 text-xs!"
            disabled={resumeDisabled}
            title={resumeTitle()}
            onClick={(e) => {
              // Don't also trigger the row's open-transcript click behind us.
              e.stopPropagation();
              onResume();
            }}
          >
            Resume
          </Button>
        )}
        {canEnd && (
          <Button
            type="button"
            variant={confirmEnd ? "armed" : "secondary"}
            className="absolute right-3 top-1/2 min-h-11 min-w-11 -translate-y-1/2 whitespace-nowrap text-xs!"
            disabled={endMutation.isPending}
            aria-label={confirmEnd ? `Confirm ${actionLabel.toLowerCase()}` : actionLabel}
            title={isTerminal
              ? "Hide this session while keeping its transcript."
              : "End and hide this session while keeping its transcript."}
            onClick={(e) => {
              e.stopPropagation();
              if (!confirmEnd) setConfirmEnd(true);
              else void end();
            }}
          >
            {endMutation.isPending ? "…" : confirmEnd ? "✓" : "×"}
          </Button>
        )}
      </div>
      {endError && (
        <div className="session-row-end-error" role="alert">
          <span className="session-row-end-error__message">{endError}</span>
        </div>
      )}
    </li>
  );
}
