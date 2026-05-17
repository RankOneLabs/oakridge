import type { EnvelopeEvent } from "../../types";

export function AutoApprovedNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload ?? {}) as {
    tool_name?: unknown;
    reason?: unknown;
  };
  const tool = typeof p.tool_name === "string" ? p.tool_name : "tool";
  const reason =
    p.reason === "yolo"
      ? "yolo"
      : typeof p.reason === "string" && p.reason.startsWith("profile:")
        ? p.reason
        : "always allow";
  return (
    <div className="row row-system">
      <div className="notice notice-allow">
        auto-approved · {tool} <span className="notice-tag">({reason})</span>
      </div>
    </div>
  );
}
