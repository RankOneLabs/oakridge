import type { EnvelopeEvent } from "../../types";

export function AutoDeniedNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload ?? {}) as {
    tool_name?: unknown;
    reason?: unknown;
  };
  const tool = typeof p.tool_name === "string" ? p.tool_name : "tool";
  const reason = typeof p.reason === "string" ? p.reason : "profile";
  return (
    <div className="row row-system">
      <div className="notice notice-deny">
        auto-denied · {tool} <span className="notice-tag">({reason})</span>
      </div>
    </div>
  );
}
