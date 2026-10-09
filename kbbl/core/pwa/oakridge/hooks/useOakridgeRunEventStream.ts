import { useEffect, useRef } from "react";
import { LiveSubscription } from "../../lib/live-stream";
import type { OperatorRunEvent } from "../operator-contracts";

function parseOperatorEvent(data: string): OperatorRunEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && "run_id" in value && typeof value.run_id === "string"
      && "scope_id" in value && typeof value.scope_id === "string" ? value as OperatorRunEvent : null;
  } catch { return null; }
}

/** Committed transitions from the authority (GET /events), relayed through kbbl's shared live connection. */
export function useOakridgeRunEventStream(isEnabled: boolean, subscriber: (event: OperatorRunEvent) => void): void {
  const subscriberRef = useRef(subscriber);
  subscriberRef.current = subscriber;
  useEffect(() => {
    if (!isEnabled) return;
    const subscription = new LiveSubscription("/oakridge/api/events");
    subscription.addEventListener("run_event", (message) => {
      const event = parseOperatorEvent(message.data);
      if (event) subscriberRef.current(event);
    });
    return () => subscription.close();
  }, [isEnabled]);
}
