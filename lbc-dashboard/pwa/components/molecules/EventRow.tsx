/**
 * One row in the event timeline. Renders timestamp + event kind +
 * pretty-printed JSON payload. Used by the EventList organism.
 */
import type { CellEvent } from "../../lib/types";

export function EventRow({ event }: { event: CellEvent }) {
  return (
    <li className="border-b border-stone-100 py-2 text-[13px]">
      <span className="mr-2 text-[11px] text-stone-500">
        {new Date(event.ts).toLocaleTimeString()}
      </span>
      <span className="font-semibold">{event.kind}</span>
      <pre className="mt-1 overflow-auto bg-stone-50 p-2 text-[11px]">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </li>
  );
}
