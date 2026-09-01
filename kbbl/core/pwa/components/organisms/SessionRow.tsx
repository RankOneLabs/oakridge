import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { SessionSnapshot } from "../../types";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { prettyEffortLabel, prettyModelLabel } from "../../lib/format";
import { refusalOf, sessionCloseError } from "../../lib/session-close";
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
  // Resume = new session inheriting this one's worktree — only meaningful
  // for a closed ACP session (pre-ACP archives can't inherit).
  const canResume =
    snapshot.source === "acp" &&
    (snapshot.status === "ended" ||
      snapshot.status === "fenced" ||
      snapshot.status === "failed");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Server pushes a fresh /inbox snapshot after the purge drops the row,
  // so there is no optimistic UI. A failure has to be rendered though: the
  // execution-hold refusal is deterministic, so a silent failure left the
  // operator tapping Remove forever with nothing to read and no way past.
  const removeMutation = useMutation({
    mutationFn: async ({ force }: { force: boolean }) => {
      const query = force ? "?purge=true&force=1" : "?purge=true";
      const res = await fetch(`/sessions/${encodeURIComponent(snapshot.sid)}${query}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await sessionCloseError(res);
    },
  });
  const refusal = removeMutation.isError ? refusalOf(removeMutation.error) : null;
  const removeError = removeMutation.isError
    ? (refusal?.message ??
      (removeMutation.error instanceof Error
        ? removeMutation.error.message
        : "Could not remove the session."))
    : null;

  // Auto-clear the confirm-pending state after a few seconds so a stray
  // first tap doesn't leave a primed Remove button waiting indefinitely.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  // The rejection is swallowed because the failure is already rendered from
  // mutation state; letting it escape only produced an unhandled rejection on
  // a path that is in fact handled.
  async function remove(force: boolean) {
    if (removeMutation.isPending) return;
    try {
      await removeMutation.mutateAsync({ force });
    } catch {
      // Rendered below via removeMutation.isError.
    } finally {
      setConfirmRemove(false);
    }
  }

  const isOpen =
    snapshot.status !== "ended" &&
    snapshot.status !== "fenced" &&
    snapshot.status !== "failed";

  return (
    <li className="session-row-li">
      {/* Anchors the absolutely-positioned Resume/Remove buttons to the row
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
          <button
            type="button"
            className="btn-resume"
            disabled={resumeDisabled}
            title={resumeTitle()}
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
          disabled={removeMutation.isPending}
          title={
            isOpen
              ? "Closes the agent session and deletes its record."
              : "Deletes the session record."
          }
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            void remove(false);
          }}
        >
          {removeMutation.isPending
            ? "removing…"
            : confirmRemove
              ? "tap to confirm"
              : "Remove"}
        </button>
      </div>
      {removeError && (
        <div className="session-row-remove-error" role="alert">
          <span className="session-row-remove-error__message">{removeError}</span>
          {/* Only a hold is overridable, and only once the operator has read
              why — which is exactly the authority the server grants ?force=1. */}
          {refusal?.kind === "held_by_execution" && (
            <button
              type="button"
              className="btn-remove-force"
              disabled={removeMutation.isPending}
              title="Removes the session anyway, abandoning the unit this run is waiting on."
              onClick={(e) => {
                e.stopPropagation();
                void remove(true);
              }}
            >
              Remove anyway
            </button>
          )}
        </div>
      )}
    </li>
  );
}
