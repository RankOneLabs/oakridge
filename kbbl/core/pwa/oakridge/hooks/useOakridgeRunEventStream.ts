import { useEffect, useRef } from "react";

import { parseOakridgeRunEventFrame } from "../client";
import type { RunEventFrame } from "../types";

type StreamEventName = "invalidate" | "run_event";
type StreamListener = (event: MessageEvent<string>) => void;

const listeners: Record<StreamEventName, Set<StreamListener>> = {
  invalidate: new Set(),
  run_event: new Set(),
};
let source: EventSource | null = null;

const dispatch = (name: StreamEventName) => (event: Event): void => {
  for (const listener of listeners[name]) listener(event as MessageEvent<string>);
};

const dispatchers = { invalidate: dispatch("invalidate"), run_event: dispatch("run_event") };

/** Both Oakridge hooks subscribe through this one browser connection. */
export const subscribeOakridgeStream = (name: StreamEventName, listener: StreamListener): (() => void) => {
  listeners[name].add(listener);
  if (!source) {
    source = new EventSource("/oakridge/api/events");
    source.addEventListener("invalidate", dispatchers.invalidate);
    source.addEventListener("run_event", dispatchers.run_event);
  }
  return () => {
    listeners[name].delete(listener);
    if (listeners.invalidate.size > 0 || listeners.run_event.size > 0 || !source) return;
    source.removeEventListener("invalidate", dispatchers.invalidate);
    source.removeEventListener("run_event", dispatchers.run_event);
    source.close();
    source = null;
  };
};

/**
 * Best-effort, toast-only run-event frames. The subscriber owns replay policy
 * so the production notification selector is the one that suppresses them.
 */
export function useOakridgeRunEventStream(isEnabled: boolean, subscriber: (frame: RunEventFrame) => void): void {
  const subscriberRef = useRef(subscriber);
  subscriberRef.current = subscriber;
  useEffect(() => {
    if (!isEnabled) return;
    return subscribeOakridgeStream("run_event", (message) => {
      const frame = parseOakridgeRunEventFrame(message.data);
      if (frame) subscriberRef.current(frame);
    });
  }, [isEnabled]);
}
