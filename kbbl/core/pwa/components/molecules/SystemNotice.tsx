import type { EnvelopeEvent, RuntimeSessionObservedPayload, RuntimeErrorPayload } from "../../types";
import { formatResultText } from "../../lib/events";
import type { SystemNoticePayload } from "../../lib/events";

export function SystemNotice({
  event,
  compact,
}: {
  event: EnvelopeEvent;
  compact: boolean;
}) {
  const p = (event.payload as SystemNoticePayload | null) ?? {};
  let text: string;
  switch (event.type) {
    case "session_started":
      text = `session started (${String(p.sessionId ?? "").slice(0, 8)}…)`;
      break;
    case "subprocess_exited":
      text = `subprocess exited: ${String(p.reason ?? "unknown")} (code ${String(p.code ?? "?")})`;
      break;
    case "subprocess_stderr":
      text = `stderr: ${String(p.line ?? "")}`;
      break;
    case "rate_limit_event":
      text = "rate limit event";
      break;
    case "yolo_mode_changed":
      text = `yolo mode ${p.enabled ? "enabled" : "disabled"}`;
      break;
    case "tool_allowlisted":
      text = `always allow: ${String(p.tool_name ?? "?")}`;
      break;
    case "result":
      text = formatResultText(p);
      break;
    case "cc_session_id_observed":
      text = `CC session id ${String(p.cc_session_id ?? "").slice(0, 8)}…`;
      break;
    case "runtime_session_observed": {
      const rp = (event.payload as RuntimeSessionObservedPayload | null) ?? {};
      text = `runtime ${rp.runtime_id ?? "?"} session ${(rp.runtime_sid ?? "").slice(0, 8)}…`;
      break;
    }
    case "runtime_error": {
      const rp = (event.payload as RuntimeErrorPayload | null) ?? {};
      text = `runtime error: ${rp.message ?? "unknown"}`;
      break;
    }
    case "runtime_disconnected":
      text = "runtime disconnected";
      break;
    case "system": {
      const raw = event.payload as { subtype?: string } | null;
      text = `system: ${String(raw?.subtype ?? "event")}`;
      break;
    }
    default:
      text = event.type;
  }
  // In compact mode the `#N` sequence id is gutter info — moved to the row's
  // title attribute so it's still inspectable on hover but doesn't bracket
  // every system line. Operators told us the bare id was never actionable.
  return (
    <div className="row row-system" title={`event #${event.id}`}>
      <div className="notice">
        {!compact && <span className="notice-tag">#{event.id}</span>}
        {text}
      </div>
    </div>
  );
}
