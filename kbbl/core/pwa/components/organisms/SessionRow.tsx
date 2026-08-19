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
  const canResume = snapshot.status === "ended";
  const [confirmRemove, setConfirmRemove] = useState(false);
  const primaryModel = snapshot.initialObservedModel ?? snapshot.model;
  const primaryModelLabel = snapshot.initialObservedModel ? "initial" : "requested";
  const currentModel = snapshot.observedModel;
  const shouldShowCurrentModel =
    Boolean(primaryModel && currentModel) && currentModel !== primaryModel;

  // Server broadcasts session_removed; the inbox handler drops the row, so
  // there is no optimistic UI. A failure has to be rendered though: the
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
              {snapshot.status === "compacting" ? "compacting…" : snapshot.status}
            </span>
            <span className="session-row-name" title={snapshot.sid}>
              {snapshot.name || snapshot.sid.slice(0, 8)}
            </span>
            {primaryModel && (
              <span className="session-row-model" title={`${primaryModelLabel}: ${primaryModel}`}>
                {primaryModelLabel} {prettyModelLabel(primaryModel)}
              </span>
            )}
            {shouldShowCurrentModel && currentModel && (
              <span className="session-row-model" title={`current: ${currentModel}`}>
                current {prettyModelLabel(currentModel)}
              </span>
            )}
            {snapshot.effort && (
              <span className="session-row-effort" title={`effort: ${snapshot.effort}`}>
                effort {prettyEffortLabel(snapshot.effort)}
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
          disabled={removeMutation.isPending}
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
