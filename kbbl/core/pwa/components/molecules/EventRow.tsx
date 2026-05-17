import type { EnvelopeEvent, ResolutionMap, SessionStatus } from "../../types";
import { isLowSignalEvent } from "../../lib/events";
import { AutoApprovedNotice } from "../atoms/AutoApprovedNotice";
import { AutoDeniedNotice } from "../atoms/AutoDeniedNotice";
import { UnknownRow } from "../atoms/UnknownRow";
import { SystemNotice } from "./SystemNotice";
import { UserRow } from "./UserRow";
import { AssistantRow } from "./AssistantRow";
import { PermissionRow } from "./PermissionRow";

export function EventRow({
  event,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  // stream_event deltas are reconstructed by InFlightAssistantRow; never
  // surface them as a row, even with showSystemEvents on.
  if (event.type === "stream_event") return null;
  if (!showSystemEvents && isLowSignalEvent(event)) return null;
  switch (event.type) {
    case "user":
      return (
        <UserRow
          event={event}
          showSystemEvents={showSystemEvents}
          isLatest={isLatest}
        />
      );
    case "assistant":
      return (
        <AssistantRow
          event={event}
          showSystemEvents={showSystemEvents}
          isLatest={isLatest}
        />
      );
    case "permission_request":
      return (
        <PermissionRow
          event={event}
          resolutions={resolutions}
          allowedTools={allowedTools}
          sid={sid}
          sessionStatus={sessionStatus}
          showSystemEvents={showSystemEvents}
        />
      );
    case "permission_resolved":
      // folded into the matching permission_request card
      return null;
    case "permission_auto_approved":
      if (!showSystemEvents) return null;
      return <AutoApprovedNotice event={event} />;
    case "permission_auto_denied":
      if (!showSystemEvents) return null;
      return <AutoDeniedNotice event={event} />;
    case "yolo_mode_changed":
    case "tool_allowlisted":
      return <SystemNotice event={event} compact={!showSystemEvents} />;
    case "system":
    case "session_started":
    case "subprocess_exited":
    case "subprocess_stderr":
    case "rate_limit_event":
    case "result":
    case "cc_session_id_observed":
      return <SystemNotice event={event} compact={!showSystemEvents} />;
    default:
      return <UnknownRow event={event} compact={!showSystemEvents} />;
  }
}
