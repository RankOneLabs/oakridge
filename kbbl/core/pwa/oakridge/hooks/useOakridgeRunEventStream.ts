import { useEffect, useRef } from "react";
import { LiveSubscription } from "../../lib/live-stream";
import type { OperatorRunEvent, OperatorStreamFrameData } from "../operator-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRun } from "../lib/operator-invalidation";

type StreamedRunEvent = OperatorRunEvent & Pick<OperatorStreamFrameData, "replay">;

function parseOperatorEvent(data: string): StreamedRunEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && "run_id" in value && typeof value.run_id === "string"
      && "unit_id" in value && typeof value.unit_id === "string" && "replay" in value && typeof value.replay === "boolean"
      ? value as StreamedRunEvent : null;
  } catch { return null; }
}

/** Committed events from the authority (GET /events), relayed through kbbl's shared live connection. Each refreshes its run. */
export function useOakridgeRunEventStream(isEnabled: boolean, subscriber: (event: OperatorRunEvent) => void): void {
  const client = useQueryClient();
  const subscriberRef = useRef(subscriber);
  subscriberRef.current = subscriber;
  useEffect(() => {
    if (!isEnabled) return;
    const subscription = new LiveSubscription("/oakridge/api/events");
    subscription.addEventListener("run_event", (message) => {
      const event = parseOperatorEvent(message.data);
      if (!event) return;
      invalidateRun(client, event.run_id);
      // A replayed event already happened before this connection; it refreshes but does not notify.
      if (!event.replay) subscriberRef.current(event);
    });
    return () => subscription.close();
  }, [client, isEnabled]);
}
