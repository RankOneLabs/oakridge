import type { CellEvent, CellRunMetadata } from "../../lib/types";
import { RunEventCard } from "./RunEventCard";

export interface EventRowProps {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
  eventIndex: number;
  allEvents: CellEvent[];
}

export function EventRow({
  event,
  runMetadata,
  eventIndex,
  allEvents,
}: EventRowProps) {
  return (
    <RunEventCard
      event={event}
      runMetadata={runMetadata}
      eventIndex={eventIndex}
      allEvents={allEvents}
    />
  );
}
