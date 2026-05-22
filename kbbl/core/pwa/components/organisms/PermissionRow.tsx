import type { EnvelopeEvent, ResolutionMap, PermissionRequestPayload, SessionStatus } from "../../types";
import { usePermissionDecision } from "../../hooks/usePermissionDecision";

export function PermissionRow({
  event,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
}) {
  const p = event.payload as PermissionRequestPayload;
  const resolution = resolutions.get(p.request_id);
  const {
    decide,
    approveForTask,
    localPending,
    localError,
    approveForTaskPending,
  } = usePermissionDecision(sid);

  if (resolution) {
    // Compact mode: drop the post-resolution notice entirely. The next event
    // (the actual tool_use / tool_result) is enough confirmation that the
    // approval went through.
    if (!showSystemEvents) return null;
    return (
      <div className="row row-system">
        <div className={`notice notice-${resolution}`}>
          {resolution === "allow" ? "approved" : "denied"} · {p.tool_name}
        </div>
      </div>
    );
  }

  // Only collapse to a read-only notice when the session is definitively
  // ended. For "starting" or a still-loading inbox snapshot (null), fall
  // through to the normal buttons — realistic case is a brief window where
  // the inbox hasn't delivered the snapshot yet, and the server will
  // 404/503 if the operator taps before it's ready. "session ended"
  // messaging is wrong for those cases.
  if (sessionStatus === "ended") {
    return (
      <div className="row row-system">
        <div className="notice notice-muted">
          unresolved · {p.tool_name} (session ended)
        </div>
      </div>
    );
  }

  const inputPreview = JSON.stringify(p.tool_input, null, 2);
  // If the tool is already on the session allowlist, hide the redundant
  // "always allow" button — server would have auto-approved this request
  // had it arrived after the allowlist entry, so a stale parked card might
  // still show it; one tap suffices.
  const showAlways = !allowedTools.has(p.tool_name);

  return (
    <div className="card card-permission">
      <div className="card-permission-header">Approve {p.tool_name}?</div>
      <pre className="card-body">{inputPreview}</pre>
      {localError && <div className="card-error">error: {localError}</div>}
      <div className="card-permission-buttons">
        <button
          type="button"
          className="btn-deny"
          disabled={localPending || approveForTaskPending}
          onClick={() => void decide(p.request_id, "deny")}
        >
          Deny
        </button>
        {showAlways && (
          <button
            type="button"
            className="btn-always"
            disabled={localPending || approveForTaskPending}
            onClick={() => void decide(p.request_id, "approve", "always")}
            title={`Approve and auto-allow all future ${p.tool_name} calls this session`}
          >
            Always {p.tool_name}
          </button>
        )}
        <button
          type="button"
          className="btn-approve-task"
          disabled={localPending || approveForTaskPending}
          onClick={() => void approveForTask(p.tool_name, p.request_id)}
          title={`Approve and remember for this task (persists across sessions)`}
        >
          {approveForTaskPending ? "Saving…" : "Approve for task"}
        </button>
        <button
          type="button"
          className="btn-approve"
          disabled={localPending || approveForTaskPending}
          onClick={() => void decide(p.request_id, "approve")}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
