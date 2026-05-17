import { useMemo } from "react";

import type { EnvelopeEvent, ResolutionMap, SessionStatus } from "../../types";
import { buildListItems } from "../../lib/events";
import { CompactingRow } from "../molecules/CompactingRow";
import { EventRow } from "../molecules/EventRow";
import { ToolBatchSection } from "./ToolBatchSection";

export function EventList({
  events,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
  latestEventId,
}: {
  events: EnvelopeEvent[];
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
  latestEventId: number | null;
}) {
  const items = useMemo(
    () => buildListItems(events, resolutions, showSystemEvents),
    [events, resolutions, showSystemEvents],
  );
  return (
    <div className="events">
      {items.map((item) => {
        if (item.kind === "tool_batch") {
          return (
            <ToolBatchSection key={`batch-${item.firstId}`} events={item.events} />
          );
        }
        if (item.kind === "compact") {
          return (
            <CompactingRow
              key={`compact-${item.startEvent.id}`}
              startEvent={item.startEvent}
              doneEvent={item.doneEvent}
            />
          );
        }
        return (
          <EventRow
            key={item.event.id}
            event={item.event}
            resolutions={resolutions}
            allowedTools={allowedTools}
            sid={sid}
            sessionStatus={sessionStatus}
            showSystemEvents={showSystemEvents}
            isLatest={item.event.id === latestEventId}
          />
        );
      })}
    </div>
  );
}
